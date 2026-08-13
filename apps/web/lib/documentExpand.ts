import {
  documentSummarySchema,
  findUnverifiableKeyPoints,
  type DocumentSectionShape,
  type KeyPointShape,
} from "@analytics/shared";
import type { Payload } from "payload";

import {
  ClaudeExpandBillingError,
  ClaudeExpandValidationError,
  type ClaudeDocumentExpandClient,
} from "./claudeDocumentExpandClient";

/**
 * Section 10.0 Step 4's flow, factored out of the route handler for the same
 * reason lib/promptEdit.ts and lib/chat.ts are: testable with a stubbed
 * expandClient, no real Claude call, no real spend.
 */

const MAX_SECTION_ID_LENGTH = 200;

export type DocumentExpandDeps = {
  payload: Payload;
  expandClient: ClaudeDocumentExpandClient;
};

export type DocumentExpandResult =
  | { ok: true; documentId: string; summaryVersion: number; newKeyPoints: KeyPointShape[] }
  | { ok: false; status: number; error: string };

type StoredDocumentData = {
  fullText?: string;
  sections?: DocumentSectionShape[];
};

const isOutputQualityFailure = (error: unknown): boolean =>
  error instanceof ClaudeExpandValidationError;

export const runDocumentExpand = async (
  documentId: string,
  afterPointId: string | undefined,
  focusSectionId: string | undefined,
  expandedByUserId: number,
  deps: DocumentExpandDeps,
): Promise<DocumentExpandResult> => {
  const { payload, expandClient } = deps;

  if (focusSectionId && focusSectionId.length > MAX_SECTION_ID_LENGTH) {
    return { ok: false, status: 400, error: "focusSectionId is too long." };
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
      error: "This document has no stored text yet. Nothing to expand.",
    };
  }

  if (focusSectionId && !sections.some((section) => section.sectionId === focusSectionId)) {
    return {
      ok: false,
      status: 400,
      error: `focusSectionId "${focusSectionId}" is not a known section of this document.`,
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
      error: "No summary exists for this document yet. Nothing to expand.",
    };
  }

  const existingKeyPoints = (currentSummaryRecord.keyPoints ?? []) as KeyPointShape[];

  if (afterPointId && !existingKeyPoints.some((point) => point.pointId === afterPointId)) {
    return {
      ok: false,
      status: 400,
      error: `afterPointId "${afterPointId}" is not a known key point of this document's current summary.`,
    };
  }

  const attempt = async (stricterInstruction?: string) =>
    expandClient.expandSummary(
      fullText,
      sections,
      existingKeyPoints,
      focusSectionId,
      stricterInstruction ? { stricterInstruction } : undefined,
    );

  let expanded;

  try {
    expanded = await attempt();
  } catch (firstError: unknown) {
    if (!isOutputQualityFailure(firstError)) {
      if (firstError instanceof ClaudeExpandBillingError) {
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
      `Document expand failed validation, retrying once with stricter instruction on model "${expandClient.retryModelName}". Violation: ${violation}`,
    );

    const stricter = [
      `The exact violation was: ${violation}`,
      "Return only NEW key points, none repeating an existing pointId.",
      "Every quote must be a verbatim substring of fullText. Every",
      "supportingSectionIds entry must be a real sectionId, verbatim. Call",
      "emit_document_summary exactly once.",
    ].join(" ");

    try {
      expanded = await attempt(stricter);
    } catch (secondError: unknown) {
      if (secondError instanceof ClaudeExpandBillingError) {
        return { ok: false, status: 503, error: secondError.message };
      }

      const detail =
        secondError instanceof Error
          ? secondError.message
          : String(secondError);

      return {
        ok: false,
        status: 502,
        error: `Document expand failed validation twice, second attempt used model "${expandClient.retryModelName}". First violation: ${violation} Second failure: ${detail}`,
      };
    }
  }

  /**
   * Validated once already inside expandClient.expandSummary; validated
   * again here, immediately before the Summaries write, so nothing invalid
   * can reach storage regardless of which client implementation produced it
   * -- the same deliberate duplication the config-generation and
   * prompt-edit paths already use.
   */
  const revalidated = documentSummarySchema.safeParse(expanded);

  if (!revalidated.success) {
    return {
      ok: false,
      status: 502,
      error: `Expand response failed re-validation before storage: ${JSON.stringify(revalidated.error.issues)}`,
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
      error: `Expand response has key points that don't verify against the source text: ${unverifiable.join("; ")}`,
    };
  }

  const duplicateIds = existingKeyPoints
    .map((point) => point.pointId)
    .filter((id) => revalidated.data.keyPoints.some((point) => point.pointId === id));

  if (duplicateIds.length > 0) {
    return {
      ok: false,
      status: 502,
      error: `Expand response reused existing pointId(s): ${duplicateIds.join(", ")}`,
    };
  }

  // Appends to the stored keyPoints list (Section 10.0 Step 4), versioned
  // the same way Configs already version: max existing version, + 1.
  const priorSummaries = await payload.find({
    collection: "summaries",
    where: { document: { equals: Number(documentId) } },
    limit: 1,
    depth: 0,
    sort: "-version",
  });
  const nextVersion = (priorSummaries.docs[0]?.version ?? 0) + 1;

  const mergedKeyPoints = [...existingKeyPoints, ...revalidated.data.keyPoints];

  await payload.create({
    collection: "summaries",
    data: {
      document: Number(documentId),
      version: nextVersion,
      keyPoints: mergedKeyPoints,
      generatedBy: "expand",
      expandedBy: expandedByUserId,
    },
  });

  return {
    ok: true,
    documentId: String(documentId),
    summaryVersion: nextVersion,
    newKeyPoints: revalidated.data.keyPoints,
  };
};
