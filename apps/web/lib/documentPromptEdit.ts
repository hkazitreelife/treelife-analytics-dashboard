import {
  documentSummarySchema,
  findUnverifiableKeyPoints,
  type DocumentSectionShape,
  type KeyPointShape,
} from "@analytics/shared";
import type { Payload } from "payload";

import {
  ClaudeDocumentEditBillingError,
  ClaudeDocumentEditValidationError,
  type ClaudeDocumentEditClient,
} from "./claudeDocumentEditClient";

/**
 * Section 10.2 Step 3's editing flow, factored out of the route handler for
 * the same reason lib/promptEdit.ts is. Distinct from lib/documentExpand.ts
 * (Step 4, "give me more"): expand appends new points and never touches the
 * existing ones; this REPLACES the stored keyPoints list wholesale with
 * whatever complete list the edit produces (reordered, filtered, reworded).
 * Both still version forward the same way (max existing version + 1, old
 * versions kept, never mutated), so the distinction is in what "the new
 * version's keyPoints" actually contains, not in how it's stored.
 */

const MAX_PROMPT_LENGTH = 2000;

export type DocumentPromptEditDeps = {
  payload: Payload;
  editClient: ClaudeDocumentEditClient;
};

export type DocumentPromptEditResult =
  | { ok: true; documentId: string; summaryVersion: number; keyPoints: KeyPointShape[] }
  | { ok: false; status: number; error: string };

type StoredDocumentData = {
  fullText?: string;
  sections?: DocumentSectionShape[];
};

const isOutputQualityFailure = (error: unknown): boolean =>
  error instanceof ClaudeDocumentEditValidationError;

export const runDocumentPromptEdit = async (
  documentId: string,
  prompt: string,
  editedByUserId: number,
  deps: DocumentPromptEditDeps,
): Promise<DocumentPromptEditResult> => {
  const { payload, editClient } = deps;

  const trimmedPrompt = prompt.trim();

  if (trimmedPrompt.length === 0) {
    return { ok: false, status: 400, error: "prompt must not be empty." };
  }

  if (trimmedPrompt.length > MAX_PROMPT_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: `prompt must be ${MAX_PROMPT_LENGTH} characters or fewer.`,
    };
  }

  let document;

  try {
    document = await payload.findByID({
      collection: "documents",
      id: documentId,
      depth: 0,
    });
  } catch {
    return { ok: false, status: 404, error: "Document not found." };
  }

  const stored = document.data as StoredDocumentData | null;
  const fullText = stored?.fullText;
  const sections = stored?.sections ?? [];

  if (!fullText || sections.length === 0) {
    return {
      ok: false,
      status: 409,
      error: "This document has no stored text yet. Nothing to edit.",
    };
  }

  const latestSummaries = await payload.find({
    collection: "summaries",
    where: { document: { equals: Number(documentId) } },
    limit: 1,
    depth: 0,
    sort: "-version,-createdAt",
  });

  const currentSummaryRecord = latestSummaries.docs[0];

  if (!currentSummaryRecord) {
    return {
      ok: false,
      status: 404,
      error: "No summary exists for this document yet. Nothing to edit.",
    };
  }

  const currentKeyPoints = (currentSummaryRecord.keyPoints ?? []) as KeyPointShape[];

  const attempt = async (stricterInstruction?: string) =>
    editClient.editSummary(
      currentKeyPoints,
      fullText,
      sections,
      trimmedPrompt,
      stricterInstruction ? { stricterInstruction } : undefined,
    );

  let edited;

  try {
    edited = await attempt();
  } catch (firstError: unknown) {
    if (!isOutputQualityFailure(firstError)) {
      if (firstError instanceof ClaudeDocumentEditBillingError) {
        return { ok: false, status: 503, error: firstError.message };
      }

      return {
        ok: false,
        status: 502,
        error:
          firstError instanceof Error ? firstError.message : String(firstError),
      };
    }

    const violation =
      firstError instanceof Error ? firstError.message : String(firstError);

    payload.logger.warn(
      `Document prompt edit failed validation, retrying once with stricter instruction on model "${editClient.retryModelName}". Violation: ${violation}`,
    );

    const stricter = [
      `The exact violation was: ${violation}`,
      "Return the complete keyPoints list -- every point that should still",
      "exist after this edit -- not a diff and not only the changed points.",
      "Every quote must be a verbatim substring of fullText. Every",
      "supportingSectionIds entry must be a real sectionId, verbatim. Call",
      "emit_document_summary exactly once.",
    ].join(" ");

    try {
      edited = await attempt(stricter);
    } catch (secondError: unknown) {
      if (secondError instanceof ClaudeDocumentEditBillingError) {
        return { ok: false, status: 503, error: secondError.message };
      }

      const detail =
        secondError instanceof Error
          ? secondError.message
          : String(secondError);

      return {
        ok: false,
        status: 502,
        error: `Document prompt edit failed validation twice, second attempt used model "${editClient.retryModelName}". First violation: ${violation} Second failure: ${detail}`,
      };
    }
  }

  /**
   * Validated once already inside editClient.editSummary; validated again
   * here, immediately before the Summaries write, same deliberate
   * duplication every other pathway in this pipeline uses.
   */
  const revalidated = documentSummarySchema.safeParse(edited);

  if (!revalidated.success) {
    return {
      ok: false,
      status: 502,
      error: `Edited summary failed re-validation before storage: ${JSON.stringify(revalidated.error.issues)}`,
    };
  }

  const unverifiable = findUnverifiableKeyPoints(
    revalidated.data.keyPoints,
    fullText,
    sections,
  );

  if (unverifiable.length > 0) {
    return {
      ok: false,
      status: 502,
      error: `Edited summary has key points that don't verify against the source text: ${unverifiable.join("; ")}`,
    };
  }

  // Version is never hardcoded: max existing version for this document, + 1.
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
      generatedBy: "prompt_edit",
      expandedBy: editedByUserId,
    },
  });

  return {
    ok: true,
    documentId: String(documentId),
    summaryVersion: nextVersion,
    keyPoints: revalidated.data.keyPoints,
  };
};
