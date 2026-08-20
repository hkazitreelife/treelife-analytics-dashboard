import { resolveSessionChatAnswer, type ResolvedMetric } from "@analytics/shared";
import type { Payload } from "payload";

import type { ChatClient } from "./claudeChatClient";
import { ChatBillingError, ChatValidationError } from "./claudeChatClient";
import type { DocumentChatClient } from "./claudeDocumentChatClient";
import {
  DocumentChatBillingError,
  DocumentChatValidationError,
} from "./claudeDocumentChatClient";
import type { SessionChatClient } from "./claudeSessionChatClient";
import {
  SessionChatBillingError,
  SessionChatValidationError,
} from "./claudeSessionChatClient";
import { runChatQuestion } from "./chat";
import { runDocumentChatQuestion } from "./documentChat";
import { relationshipIds, loadSessionSources } from "./sessionSources";

/**
 * Prompt 15.0 Part 2 item 4. The universal session chat endpoint's logic.
 * A single-source session delegates to the exact existing per-dataset/
 * per-document chat function, completely unchanged -- this guarantees a
 * single-source session's chat answer is identical to what calling the old
 * per-source endpoint directly would produce, because it IS that call.
 * A multi-source session builds context from every source and asks
 * claudeSessionChatClient.ts, which can draw on any of them.
 *
 * Every turn -- either path -- is persisted to ConversationTurns before
 * returning, so reopening the session later restores it.
 */

export type SessionChatDeps = {
  payload: Payload;
  chatClient: ChatClient;
  documentChatClient: DocumentChatClient;
  sessionChatClient: SessionChatClient;
  userId: number;
};

export type SessionChatAnswer = {
  directAnswer: string;
  metrics: (ResolvedMetric & { datasetName?: string })[];
  citations: { sectionId: string; quote: string; documentName?: string }[];
  caveats?: string;
};

export type SessionChatResult =
  | { ok: true; sessionId: string; answer: SessionChatAnswer }
  | { ok: false; status: number; error: string };

const isOutputQualityFailure = (error: unknown): boolean =>
  error instanceof SessionChatValidationError;

export const runSessionChat = async (
  sessionId: string,
  message: string,
  deps: SessionChatDeps,
): Promise<SessionChatResult> => {
  const { payload, chatClient, documentChatClient, sessionChatClient, userId } = deps;

  const trimmed = message.trim();

  if (trimmed.length === 0) {
    return { ok: false, status: 400, error: "message must not be empty." };
  }

  let session;

  try {
    session = await payload.findByID({ collection: "sessions", id: sessionId, depth: 0 });
  } catch {
    return { ok: false, status: 404, error: "Session not found." };
  }

  const datasetIds = relationshipIds(session.datasets);
  const documentIds = relationshipIds(session.documents);

  const persistTurn = async (
    status: "answered" | "error",
    response: Record<string, unknown>,
    targetSourceKind?: "dataset" | "document",
    targetSourceId?: string,
  ): Promise<void> => {
    await payload.create({
      collection: "conversation-turns",
      data: {
        session: Number(sessionId),
        kind: "chat",
        message: trimmed,
        status,
        response,
        targetSourceKind,
        targetSourceId,
        createdBy: userId,
      },
    });
  };

  // Single-source: delegate to the exact existing chat function, unchanged.
  if (datasetIds.length === 1 && documentIds.length === 0) {
    const result = await runChatQuestion(datasetIds[0]!, trimmed, { payload, chatClient });

    if (!result.ok) {
      await persistTurn("error", { error: result.error });
      return result;
    }

    const answer: SessionChatAnswer = {
      directAnswer: result.directAnswer,
      metrics: result.metrics,
      citations: [],
      caveats: result.caveats,
    };

    await persistTurn("answered", answer, "dataset", datasetIds[0]);
    return { ok: true, sessionId, answer };
  }

  if (documentIds.length === 1 && datasetIds.length === 0) {
    const result = await runDocumentChatQuestion(documentIds[0]!, trimmed, {
      payload,
      chatClient: documentChatClient,
    });

    if (!result.ok) {
      await persistTurn("error", { error: result.error });
      return result;
    }

    const answer: SessionChatAnswer = {
      directAnswer: result.directAnswer,
      metrics: [],
      citations: result.citations,
      caveats: result.caveats,
    };

    await persistTurn("answered", answer, "document", documentIds[0]);
    return { ok: true, sessionId, answer };
  }

  if (datasetIds.length + documentIds.length === 0) {
    return { ok: false, status: 409, error: "This session has no sources yet." };
  }

  // Multi-source: build context from everything, ask the session chat client.
  const { datasets, documents } = await loadSessionSources(payload, datasetIds, documentIds);

  if (datasets.length + documents.length === 0) {
    return {
      ok: false,
      status: 409,
      error: "This session's sources have no stored data yet.",
    };
  }

  const datasetSourceMap = new Map(
    datasets.map((d) => [d.datasetId, { name: d.datasetName, tables: d.tables }]),
  );
  const documentSourceMap = new Map(
    documents.map((d) => [d.documentId, { name: d.documentName, fullText: d.fullText, sections: d.sections }]),
  );

  const attempt = (stricterInstruction?: string) =>
    sessionChatClient.ask(
      datasets,
      documents,
      trimmed,
      stricterInstruction ? { stricterInstruction } : undefined,
    );

  /**
   * The client already validated every metric/citation resolves (see
   * claudeSessionChatClient.ts's ask); this resolves them into the actual
   * values, same "validate inside the client, resolve/re-check at the call
   * site" split every other pathway in this pipeline uses.
   */
  const finalize = async (raw: Awaited<ReturnType<typeof attempt>>): Promise<SessionChatResult> => {
    const { resolved, errors } = resolveSessionChatAnswer(raw, datasetSourceMap, documentSourceMap);

    if (!resolved) {
      const message = `Session chat answer failed resolution at response time (already validated once inside the client): ${errors.join("; ")}`;
      await persistTurn("error", { error: message });
      return { ok: false, status: 502, error: message };
    }

    const answer: SessionChatAnswer = {
      directAnswer: resolved.directAnswer,
      metrics: resolved.metrics.map(
        (m) => ({ ...m.metric, datasetName: m.datasetName }) as ResolvedMetric & {
          datasetName?: string;
        },
      ),
      citations: resolved.citations.map((c) => ({ ...c.citation, documentName: c.documentName })),
      caveats: resolved.caveats,
    };

    await persistTurn("answered", answer);
    return { ok: true, sessionId, answer };
  };

  try {
    return await finalize(await attempt());
  } catch (firstError: unknown) {
    if (!isOutputQualityFailure(firstError)) {
      const message =
        firstError instanceof SessionChatBillingError
          ? firstError.message
          : firstError instanceof Error
            ? firstError.message
            : String(firstError);
      const status = firstError instanceof SessionChatBillingError ? 503 : 502;
      await persistTurn("error", { error: message });
      return { ok: false, status, error: message };
    }

    const violation = firstError instanceof Error ? firstError.message : String(firstError);

    payload.logger.warn(
      `Session chat failed validation, retrying once with stricter instruction on model "${sessionChatClient.retryModelName}". Violation: ${violation}`,
    );

    const stricter = [
      `The exact violation was: ${violation}`,
      "Call emit_session_chat_answer exactly once, with directAnswer, a",
      "metrics array and a citations array (either may be empty, but both",
      "must be arrays). Every metrics entry needs datasetId (a real id given",
      "to you) and metric (kind, label, plus the fields that kind needs).",
      "Every citations entry needs documentId (a real id given to you) and",
      "citation ({sectionId, quote}, quote verbatim from that document's",
      "fullText).",
    ].join(" ");

    try {
      return await finalize(await attempt(stricter));
    } catch (secondError: unknown) {
      const message =
        secondError instanceof SessionChatBillingError
          ? secondError.message
          : secondError instanceof Error
            ? secondError.message
            : String(secondError);
      const status = secondError instanceof SessionChatBillingError ? 503 : 502;
      await persistTurn("error", { error: message });
      return { ok: false, status, error: message };
    }
  }
};

// Re-exported so route handlers constructing clients can catch these
// without importing three separate modules for the error classes alone.
export { ChatBillingError, ChatValidationError, DocumentChatBillingError, DocumentChatValidationError };
