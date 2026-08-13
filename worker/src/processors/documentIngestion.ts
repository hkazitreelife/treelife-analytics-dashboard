import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  documentSummarySchema,
  findUnverifiableKeyPoints,
  normalizedDocumentSchema,
  type DocumentIngestionJobData,
} from "@analytics/shared";
import type { Payload } from "payload";

import {
  ClaudeSummaryBillingError,
  ClaudeSummaryValidationError,
  type ClaudeDocumentSummaryClient,
} from "../services/claudeDocumentSummary";
import {
  isDocumentCandidateMimeType,
  resolveDocumentSourceType,
} from "../services/documentDetector";
import {
  GeminiBillingError,
  GeminiValidationError,
  type GeminiDocumentClient,
} from "../services/geminiDocument";

/**
 * Section 10.0's narrative-document pipeline. Deliberately a separate file
 * from processors/ingestion.ts, not a branch inside it: this never touches a
 * Dataset, a Config, or any Section 14 code, and processIngestionJob is
 * unmodified. Mirrors its structure and error discipline (deterministic
 * checks before any AI call is not applicable here the same way -- the file
 * itself IS what needs an AI call to read -- but the retry-once-on-
 * validation-failure, never-store-partial-output rules are identical).
 */

export class DocumentIngestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentIngestionError";
  }
}

const MEDIA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../apps/web/media",
);

const isOutputQualityFailure = (error: unknown): boolean =>
  error instanceof GeminiValidationError ||
  error instanceof ClaudeSummaryValidationError;

export type DocumentIngestionDeps = {
  payload: Payload;
  geminiDocument: GeminiDocumentClient;
  claudeSummary: ClaudeDocumentSummaryClient;
  mediaDir?: string;
};

const loadFileBytes = async (
  mediaDir: string,
  filename: string,
): Promise<Buffer> => {
  try {
    return await readFile(path.join(mediaDir, filename));
  } catch (error: unknown) {
    throw new DocumentIngestionError(
      `Stored file "${filename}" could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export const processDocumentIngestionJob = async (
  data: DocumentIngestionJobData,
  deps: DocumentIngestionDeps,
): Promise<void> => {
  const { payload, geminiDocument, claudeSummary } = deps;
  const mediaDir = deps.mediaDir ?? MEDIA_DIR;

  // Timing instrumentation, not a permanent metric: the AI-call timings
  // added earlier only covered the two model calls themselves: this covers
  // everything else in this function (job/document status writes, the file
  // read, Payload reads/creates) plus queue latency -- the gap between the
  // job actually being enqueued and this function starting to run it,
  // which lives entirely outside this function and is invisible to any
  // timer placed inside it, so it's measured separately, from the Job
  // row's own createdAt.
  const processorStartedAt = Date.now();

  const jobRecordForTiming = await payload.findByID({
    collection: "jobs",
    id: data.jobId,
    depth: 0,
  });

  const queueLatencyMs =
    processorStartedAt - new Date(jobRecordForTiming.createdAt).getTime();

  payload.logger.info(
    `Queue latency (job row created -> worker picked it up) ${queueLatencyMs}ms for job ${data.jobId}.`,
  );

  await payload.update({
    collection: "jobs",
    id: data.jobId,
    data: { status: "processing" },
  });

  const fileRecord = await payload.findByID({
    collection: "files",
    id: data.fileId,
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
  const bytes = await loadFileBytes(mediaDir, fileRecord.filename);

  await payload.update({
    collection: "jobs",
    id: data.jobId,
    data: { status: "validating" },
  });

  const setupDurationMs = Date.now() - processorStartedAt;

  payload.logger.info(
    `Pre-extraction setup (job/status writes, file record lookup, file read) took ${setupDurationMs}ms for job ${data.jobId}.`,
  );

  const extractionAttempt = async (stricterInstruction?: string) =>
    geminiDocument.extractDocument(
      bytes,
      mimeType,
      stricterInstruction ? { stricterInstruction } : undefined,
    );

  let extraction;
  // Timing instrumentation, not a permanent metric: settles which half of a
  // run is actually slow (Gemini reading/classifying the raw file vs
  // Claude judging what matters in the extracted text) instead of guessing
  // from the total. Covers the retry too, if one happens, since that's
  // still real time this step cost.
  const extractionStartedAt = Date.now();

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

    const violation =
      firstError instanceof Error ? firstError.message : String(firstError);

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

      const detail =
        secondError instanceof Error
          ? secondError.message
          : String(secondError);

      throw new DocumentIngestionError(
        `Document extraction failed validation twice, second attempt used model "${geminiDocument.retryModelName}". First violation: ${violation} Second failure: ${detail}`,
      );
    }
  }

  const extractionDurationMs = Date.now() - extractionStartedAt;

  payload.logger.info(
    `Document extraction (Gemini, model "${geminiDocument.primaryModel}") took ${extractionDurationMs}ms for job ${data.jobId}.`,
  );

  if (extraction.documentKind === "tabular") {
    // Section 14 has no code path today that turns an arbitrary PDF/PPTX/
    // DOCX's tables into its rawRows/columnSamples shape -- that pipeline
    // has only ever consumed the deterministic xlsx/csv parser's output.
    // Building that extraction is a separate, larger problem this prompt
    // does not ask for, and Section 14 must not be touched. This is
    // therefore an explicit, honest failure, mirroring
    // UnsupportedFileTypeError, never a partial or faked routing into a
    // pipeline that cannot actually handle it.
    throw new DocumentIngestionError(
      `This file's primary content appears to be tabular data (Gemini classified it as documentKind "tabular"), not a narrative document. Full table extraction from PDF/PPTX/DOCX is not implemented in this phase -- only xlsx/csv are. If this genuinely is a narrative document, it may have been misclassified; try again or use a different file.`,
    );
  }

  const postExtractionStartedAt = Date.now();

  const normalizedCandidate = {
    documentId: data.documentId,
    sourceFile: {
      name: fileRecord.filename,
      type: resolveDocumentSourceType(mimeType),
      hash: data.fileHash,
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
    id: data.documentId,
    data: {
      data: normalized.data,
      status: "ready",
      lastError: null,
    },
  });

  await payload.update({
    collection: "jobs",
    id: data.jobId,
    data: { status: "generating_config" },
  });

  const postExtractionDurationMs = Date.now() - postExtractionStartedAt;

  payload.logger.info(
    `Post-extraction writes (schema validation, document + job status update) took ${postExtractionDurationMs}ms for job ${data.jobId}.`,
  );

  const summaryAttempt = async (stricterInstruction?: string) =>
    claudeSummary.generateSummary(
      normalized.data.fullText,
      normalized.data.sections,
      stricterInstruction ? { stricterInstruction } : undefined,
    );

  let summary;
  const summaryStartedAt = Date.now();

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

    const violation =
      firstError instanceof Error ? firstError.message : String(firstError);

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

      const detail =
        secondError instanceof Error
          ? secondError.message
          : String(secondError);

      throw new DocumentIngestionError(
        `Document summary failed validation twice, second attempt used model "${claudeSummary.retryModelName}". First violation: ${violation} Second failure: ${detail}`,
      );
    }
  }

  const summaryDurationMs = Date.now() - summaryStartedAt;

  payload.logger.info(
    `Document summary (Claude, model "${claudeSummary.primaryModel}") took ${summaryDurationMs}ms for job ${data.jobId}.`,
  );

  const postSummaryStartedAt = Date.now();

  // Re-validated here too, immediately before storage, same
  // never-trust-a-single-check discipline as the table path's
  // findUnknownReferences/insight-metric checks.
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

  // Version is never hardcoded, same query the table path uses: max
  // existing version for this document, + 1. There should never already be
  // one for a brand-new document, but this stays consistent regardless.
  const priorSummaries = await payload.find({
    collection: "summaries",
    where: { document: { equals: Number(data.documentId) } },
    limit: 1,
    depth: 0,
    sort: "-version",
  });
  const nextVersion = (priorSummaries.docs[0]?.version ?? 0) + 1;

  await payload.create({
    collection: "summaries",
    data: {
      document: Number(data.documentId),
      version: nextVersion,
      keyPoints: revalidated.data.keyPoints,
      generatedBy: "initial_summary",
    },
  });

  await payload.update({
    collection: "jobs",
    id: data.jobId,
    data: {
      status: "completed",
      completedAt: new Date().toISOString(),
      error: null,
    },
  });

  const postSummaryDurationMs = Date.now() - postSummaryStartedAt;
  const totalProcessorDurationMs = Date.now() - processorStartedAt;

  payload.logger.info(
    `Post-summary writes (re-validation, quote check, prior-version lookup, summary create, job completion) took ${postSummaryDurationMs}ms for job ${data.jobId}.`,
  );
  payload.logger.info(
    `Total time inside processDocumentIngestionJob: ${totalProcessorDurationMs}ms for job ${data.jobId} ` +
      `(queue latency ${queueLatencyMs}ms was before this and is not included).`,
  );
};
