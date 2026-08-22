import type { Payload } from "payload";
import {
  documentSummarySchema,
  findUnverifiableKeyPoints,
  normalizedDocumentSchema,
} from "@analytics/shared";

import {
  ClaudeSummaryBillingError,
  ClaudeSummaryValidationError,
  createClaudeDocumentSummaryClient,
  type ClaudeDocumentSummaryClient,
} from "./claudeDocumentSummary";
import {
  isDocumentCandidateMimeType,
  resolveDocumentSourceType,
} from "./documentDetector";
import { ensureSingleSourceSession } from "./sessionWrapper";
import {
  GeminiBillingError,
  GeminiValidationError,
  createGeminiDocumentClient,
  type GeminiDocumentClient,
} from "./geminiDocument";

/**
 * Ports worker/src/processors/documentIngestion.ts's
 * processDocumentIngestionJob into apps/web so it can run inside an
 * Inngest function (which executes as a Next.js API route handler, not a
 * separate worker process) -- mirrors that file closely rather than
 * reimplementing it differently, since its retry/validation discipline is
 * already correct and shouldn't drift from the worker's copy for no
 * reason. Deliberately the document-side counterpart to
 * directIngestion.ts, not a modification of it: this never touches a
 * Dataset, a Config, or any Section 14 code.
 */

export class DocumentIngestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentIngestionError";
  }
}

const isOutputQualityFailure = (error: unknown): boolean =>
  error instanceof GeminiValidationError ||
  error instanceof ClaudeSummaryValidationError;

/**
 * Files.dataBase64 is the one channel guaranteed to reach this function
 * regardless of where it runs (kept specifically because local disk
 * storage doesn't persist across serverless invocations) -- there is no
 * local-disk-first attempt here at all, unlike the worker's version,
 * since this always runs as a Vercel serverless function with no
 * meaningful local disk to check first.
 */
const loadFileBytes = (dataBase64: string | null | undefined, filename: string): Buffer => {
  if (!dataBase64) {
    throw new DocumentIngestionError(
      `File "${filename}" has no dataBase64 stored -- cannot reconstruct its bytes to ingest.`,
    );
  }

  return Buffer.from(dataBase64, "base64");
};

export const processDocumentIngestionDirectly = async (
  payload: Payload,
  jobId: number | string,
  documentId: number | string,
  fileId: number | string,
  fileHash: string,
  intentPrompt?: string | null,
): Promise<void> => {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

  if (!geminiApiKey) {
    throw new DocumentIngestionError("Missing GEMINI_API_KEY.");
  }
  if (!anthropicApiKey) {
    throw new DocumentIngestionError("Missing ANTHROPIC_API_KEY.");
  }

  const geminiDocument: GeminiDocumentClient = createGeminiDocumentClient(geminiApiKey);
  const claudeSummary: ClaudeDocumentSummaryClient = createClaudeDocumentSummaryClient(anthropicApiKey);

  try {
    await payload.update({
      collection: "jobs",
      id: Number(jobId),
      data: { status: "processing" },
    });

    const fileRecord = await payload.findByID({
      collection: "files",
      id: fileId,
      depth: 0,
    });

    if (!fileRecord.filename || !fileRecord.mimeType) {
      throw new DocumentIngestionError(
        "File record is missing a filename or mime type. Re-upload the file.",
      );
    }

    if (!isDocumentCandidateMimeType(fileRecord.mimeType)) {
      throw new DocumentIngestionError(
        `File type "${fileRecord.mimeType}" was routed to the document pipeline but is not a recognized document-candidate type.`,
      );
    }

    const mimeType = fileRecord.mimeType;
    const bytes = loadFileBytes((fileRecord as any).dataBase64, fileRecord.filename);

    await payload.update({
      collection: "jobs",
      id: Number(jobId),
      data: { status: "validating" },
    });

    const extractionAttempt = async (stricterInstruction?: string) =>
      geminiDocument.extractDocument(
        bytes,
        mimeType,
        stricterInstruction ? { stricterInstruction } : undefined,
      );

    let extraction;

    try {
      extraction = await extractionAttempt();
    } catch (firstError: unknown) {
      if (!isOutputQualityFailure(firstError)) {
        if (firstError instanceof GeminiBillingError) {
          throw firstError;
        }

        throw new DocumentIngestionError(
          `Document extraction first-call failure, no retry attempted: ${
            firstError instanceof Error ? firstError.message : String(firstError)
          }`,
        );
      }

      const violation = firstError instanceof Error ? firstError.message : String(firstError);

      payload.logger.warn(
        `Document extraction failed validation, retrying once on model "${geminiDocument.retryModelName}". Violation: ${violation}`,
      );

      const stricter = [
        `The exact violation was: ${violation}`,
        "Return documentKind. If narrative, also return fullText and a",
        "non-empty sections array, each with sectionId, heading and",
        "rawContent. If tabular, return only documentKind. Return JSON only.",
      ].join(" ");

      try {
        extraction = await extractionAttempt(stricter);
      } catch (secondError: unknown) {
        if (secondError instanceof GeminiBillingError) {
          throw secondError;
        }

        const detail = secondError instanceof Error ? secondError.message : String(secondError);

        throw new DocumentIngestionError(
          `Document extraction failed validation twice, second attempt used model "${geminiDocument.retryModelName}". First violation: ${violation} Second failure: ${detail}`,
        );
      }
    }

    if (extraction.documentKind === "tabular") {
      throw new DocumentIngestionError(
        `This file's primary content appears to be tabular data (Gemini classified it as documentKind "tabular"), not a narrative document. Full table extraction from PDF/PPTX/DOCX is not implemented in this phase -- only xlsx/csv are. If this genuinely is a narrative document, it may have been misclassified; try again or use a different file.`,
      );
    }

    const normalizedCandidate = {
      documentId: String(documentId),
      sourceFile: {
        name: fileRecord.filename,
        type: resolveDocumentSourceType(mimeType),
        hash: fileHash,
      },
      fullText: extraction.fullText,
      sections: extraction.sections,
    };

    const normalized = normalizedDocumentSchema.safeParse(normalizedCandidate);

    if (!normalized.success) {
      throw new DocumentIngestionError(
        `Normalized document failed schema validation: ${JSON.stringify(normalized.error.issues)}`,
      );
    }

    // Only now, after full validation, is stored data replaced.
    await payload.update({
      collection: "documents",
      id: Number(documentId),
      data: {
        data: normalized.data,
        status: "ready",
        lastError: null,
      } as any,
    });

    await payload.update({
      collection: "jobs",
      id: Number(jobId),
      data: { status: "generating_config" },
    });

    const summaryAttempt = async (stricterInstruction?: string) =>
      claudeSummary.generateSummary(
        normalized.data.fullText,
        normalized.data.sections,
        stricterInstruction || intentPrompt
          ? { stricterInstruction, adminIntent: intentPrompt ?? undefined }
          : undefined,
      );

    let summary;

    try {
      summary = await summaryAttempt();
    } catch (firstError: unknown) {
      if (!(firstError instanceof ClaudeSummaryValidationError)) {
        if (firstError instanceof ClaudeSummaryBillingError) {
          throw firstError;
        }

        throw new DocumentIngestionError(
          `Document summary first-call failure, no retry attempted: ${
            firstError instanceof Error ? firstError.message : String(firstError)
          }`,
        );
      }

      const violation = firstError instanceof Error ? firstError.message : String(firstError);

      payload.logger.warn(
        `Document summary failed validation, retrying once on model "${claudeSummary.retryModelName}". Violation: ${violation}`,
      );

      const stricter = [
        `The exact violation was: ${violation}`,
        "Every quote must be a verbatim substring of fullText -- copy the",
        "exact words, do not paraphrase. Every supportingSectionIds entry",
        "must be a sectionId given to you, verbatim. Call",
        "emit_document_summary exactly once.",
      ].join(" ");

      try {
        summary = await summaryAttempt(stricter);
      } catch (secondError: unknown) {
        if (secondError instanceof ClaudeSummaryBillingError) {
          throw secondError;
        }

        const detail = secondError instanceof Error ? secondError.message : String(secondError);

        throw new DocumentIngestionError(
          `Document summary failed validation twice, second attempt used model "${claudeSummary.retryModelName}". First violation: ${violation} Second failure: ${detail}`,
        );
      }
    }

    const revalidated = documentSummarySchema.safeParse(summary);

    if (!revalidated.success) {
      throw new DocumentIngestionError(
        `Summary failed re-validation before storage: ${JSON.stringify(revalidated.error.issues)}`,
      );
    }

    const unverifiable = findUnverifiableKeyPoints(
      revalidated.data.keyPoints,
      normalized.data.fullText,
      normalized.data.sections,
    );

    if (unverifiable.length > 0) {
      throw new DocumentIngestionError(
        `Summary has key points that don't verify against the source text: ${unverifiable.join("; ")}`,
      );
    }

    const priorSummaries = await payload.find({
      collection: "summaries",
      where: { document: { equals: Number(documentId) } },
      limit: 1,
      depth: 0,
      sort: "-version",
    });
    const nextVersion = (priorSummaries.docs[0]?.version ?? 0) + 1;

    await payload.create({
      collection: "summaries",
      data: {
        document: Number(documentId),
        version: nextVersion,
        keyPoints: revalidated.data.keyPoints,
        generatedBy: "initial_summary",
      },
    });

    const documentRecord = await payload.findByID({
      collection: "documents",
      id: documentId,
      depth: 0,
    });
    await ensureSingleSourceSession(payload, "document", documentId, documentRecord.name);

    await payload.update({
      collection: "jobs",
      id: Number(jobId),
      data: {
        status: "completed",
        completedAt: new Date().toISOString(),
        error: null,
      },
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    await payload.update({
      collection: "jobs",
      id: Number(jobId),
      data: { status: "failed", error: errorMsg },
    });

    await payload.update({
      collection: "documents",
      id: Number(documentId),
      data: { status: "failed", lastError: errorMsg } as any,
    });

    throw err;
  }
};
