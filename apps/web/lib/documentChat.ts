import {
  findUnverifiableCitations,
  type DocumentChatAnswerShape,
  type DocumentChatCitationShape,
  type DocumentSectionShape,
  type KeyPointShape,
} from "@analytics/shared";
import type { Payload } from "payload";

import {
  DocumentChatBillingError,
  DocumentChatValidationError,
  type DocumentChatClient,
} from "./claudeDocumentChatClient";

/**
 * Section 10.2's document-chat flow, factored out of the route handler for
 * the same reason lib/chat.ts is: testable with a stubbed chatClient, no
 * real Claude call, no real spend.
 *
 * Document scope is enforced structurally, identical to lib/chat.ts:
 * `documentId` -- the URL param, never anything derived from `message` --
 * is the only id ever used to read from Payload.
 */

const MAX_MESSAGE_LENGTH = 2000;

export type DocumentChatDeps = {
  payload: Payload;
  chatClient: DocumentChatClient;
};

export type DocumentChatResult =
  | {
      ok: true;
      documentId: string;
      directAnswer: string;
      citations: DocumentChatCitationShape[];
      caveats?: string;
    }
  | { ok: false; status: number; error: string };

type StoredDocumentData = {
  fullText?: string;
  sections?: DocumentSectionShape[];
};

const isOutputQualityFailure = (error: unknown): boolean =>
  error instanceof DocumentChatValidationError;

export const runDocumentChatQuestion = async (
  documentId: string,
  message: string,
  deps: DocumentChatDeps,
): Promise<DocumentChatResult> => {
  const { payload, chatClient } = deps;

  const trimmedMessage = message.trim();

  if (trimmedMessage.length === 0) {
    return { ok: false, status: 400, error: "message must not be empty." };
  }

  if (trimmedMessage.length > MAX_MESSAGE_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: `message must be ${MAX_MESSAGE_LENGTH} characters or fewer.`,
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
      error: "This document has no stored text yet. Nothing to answer from.",
    };
  }

  const latestSummaries = await payload.find({
    collection: "summaries",
    where: { document: { equals: Number(documentId) } },
    limit: 1,
    depth: 0,
    sort: "-version,-createdAt",
  });

  const existingKeyPoints = (latestSummaries.docs[0]?.keyPoints ?? []) as KeyPointShape[];

  const attempt = async (stricterInstruction?: string) =>
    chatClient.ask(
      fullText,
      sections,
      existingKeyPoints,
      trimmedMessage,
      stricterInstruction ? { stricterInstruction } : undefined,
    );

  /**
   * The client already validated every citation resolves (see
   * claudeDocumentChatClient.ts's ask); re-checked here too, the same
   * "validate inside the client, re-check at the call site" split every
   * other pathway in this pipeline uses.
   */
  const finalize = (result: DocumentChatAnswerShape): DocumentChatResult => {
    const errors = findUnverifiableCitations(result.citations, fullText, sections);

    if (errors.length > 0) {
      return {
        ok: false,
        status: 502,
        error: `Document chat answer's citations failed verification at response time (already validated once inside the client): ${errors.join("; ")}`,
      };
    }

    return {
      ok: true,
      documentId: String(documentId),
      directAnswer: result.directAnswer,
      citations: result.citations,
      caveats: result.caveats,
    };
  };

  try {
    return finalize(await attempt());
  } catch (firstError: unknown) {
    if (!isOutputQualityFailure(firstError)) {
      if (firstError instanceof DocumentChatBillingError) {
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
      `Document chat answer failed validation, retrying once with stricter instruction on model "${chatClient.retryModelName}". Violation: ${violation}`,
    );

    const stricter = [
      `The exact violation was: ${violation}`,
      "Call emit_document_chat_answer exactly once, with a non-empty",
      "directAnswer string and a citations array (it may be empty, but must",
      "be an array). Every citation's quote must be a verbatim substring of",
      "fullText, and sectionId must be a real section given to you,",
      "verbatim.",
    ].join(" ");

    try {
      return finalize(await attempt(stricter));
    } catch (secondError: unknown) {
      if (secondError instanceof DocumentChatBillingError) {
        return { ok: false, status: 503, error: secondError.message };
      }

      const detail =
        secondError instanceof Error
          ? secondError.message
          : String(secondError);

      return {
        ok: false,
        status: 502,
        error: `Document chat answer failed validation twice, second attempt used model "${chatClient.retryModelName}". First violation: ${violation} Second failure: ${detail}`,
      };
    }
  }
};
