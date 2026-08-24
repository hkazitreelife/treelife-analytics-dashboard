import {
  CONFIG_SOURCE,
  resolveInsightMetrics,
  type ResolvedDashboardConfigShape,
} from "@analytics/shared";
import type { Payload } from "payload";

import type { ClaudeCombinedDashboardClient } from "./claudeCombinedDashboardClient";
import { CombinedDashboardBillingError, CombinedDashboardValidationError } from "./claudeCombinedDashboardClient";
import type { ClaudeConfigEditClient } from "./claudeConfigEditClient";
import { ClaudeEditBillingError } from "./claudeConfigEditClient";
import type { ClaudeDocumentEditClient } from "./claudeDocumentEditClient";
import { ClaudeDocumentEditBillingError } from "./claudeDocumentEditClient";
import type { SessionEditTargetClient } from "./claudeSessionEditTargetClient";
import { SessionEditTargetBillingError } from "./claudeSessionEditTargetClient";
import { runPromptEdit } from "./promptEdit";
import { runDocumentPromptEdit } from "./documentPromptEdit";
import { relationshipIds, loadSessionSources } from "./sessionSources";
import type { publishDatasetEvent } from "./events";
import { invalidateCache } from "./cache";

export type SessionEditDeps = {
  payload: Payload;
  editClient: ClaudeConfigEditClient;
  documentEditClient: ClaudeDocumentEditClient;
  combinedDashboardClient: ClaudeCombinedDashboardClient;
  targetClient: SessionEditTargetClient;
  publishEvent: typeof publishDatasetEvent;
  userId: number;
};

export type SessionEditResult =
  | { ok: true; sessionId: string; kind: "applied"; targetKind: "dataset" | "document" | "session"; version: number }
  | { ok: true; sessionId: string; kind: "needs_clarification"; question: string }
  | { ok: false; status: number; error: string };

export const runSessionEdit = async (
  sessionId: string,
  prompt: string,
  deps: SessionEditDeps,
): Promise<SessionEditResult> => {
  const {
    payload,
    editClient,
    documentEditClient,
    combinedDashboardClient,
    targetClient,
    publishEvent,
    userId,
  } = deps;

  const trimmed = prompt.trim();

  if (trimmed.length === 0) {
    return { ok: false, status: 400, error: "prompt must not be empty." };
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
    status: "edit_applied" | "needs_clarification" | "error",
    response: Record<string, unknown>,
    targetSourceKind?: "dataset" | "document" | "session",
    targetSourceId?: string,
  ): Promise<void> => {
    await payload.create({
      collection: "conversation-turns",
      data: {
        session: Number(sessionId),
        kind: "edit",
        message: trimmed,
        status,
        response,
        targetSourceKind: targetSourceKind === "session" ? undefined : targetSourceKind,
        targetSourceId,
        createdBy: userId,
      },
    });
  };

  const applyToDataset = async (datasetId: string): Promise<SessionEditResult> => {
    const result = await runPromptEdit(datasetId, trimmed, userId, {
      payload,
      editClient,
      publishEvent,
    });

    if (!result.ok) {
      await persistTurn("error", { error: result.error }, "dataset", datasetId);
      return result;
    }

    try {
      const latestConfigs = await payload.find({
        collection: "configs",
        where: { dataset: { equals: Number(datasetId) } },
        limit: 1,
        sort: "-version",
        depth: 0,
      });
      const newConfig = latestConfigs.docs[0]?.config as ResolvedDashboardConfigShape | undefined;
      if (newConfig) {
        const currentOverview =
          session.overview && typeof session.overview === "object" ? session.overview : {};
        const existingConfig = (currentOverview as any).config;
        await payload.update({
          collection: "sessions",
          id: sessionId,
          data: {
            overview: {
              ...currentOverview,
              config: existingConfig
                ? {
                    ...existingConfig,
                    tabs: newConfig.tabs,
                  }
                : newConfig,
              // Stamp provenance: whatever this overview was before (e.g.
              // Phase A's "initial_fallback" template), an applied edit is a
              // deliberate human-directed change -- and crucially, it must
              // no longer read as "initial_fallback", or the session page's
              // upgrade-polling would keep waiting on an AI pass that this
              // edit has already superseded.
              configSource: CONFIG_SOURCE.promptEdit,
            },
          },
        });
      }
    } catch {
      // Non-fatal
    }

    await persistTurn(
      "edit_applied",
      { configVersion: result.configVersion },
      "dataset",
      datasetId,
    );

    return {
      ok: true,
      sessionId,
      kind: "applied",
      targetKind: "dataset",
      version: result.configVersion,
    };
  };

  const applyToDocument = async (documentId: string): Promise<SessionEditResult> => {
    const result = await runDocumentPromptEdit(documentId, trimmed, userId, {
      payload,
      editClient: documentEditClient,
    });

    if (!result.ok) {
      await persistTurn("error", { error: result.error }, "document", documentId);
      return result;
    }

    await persistTurn(
      "edit_applied",
      { summaryVersion: result.summaryVersion },
      "document",
      documentId,
    );

    return {
      ok: true,
      sessionId,
      kind: "applied",
      targetKind: "document",
      version: result.summaryVersion,
    };
  };

  const applyToCombinedSession = async (sessionName?: string): Promise<SessionEditResult> => {
    const { datasets, documents } = await loadSessionSources(payload, datasetIds, documentIds);

    if (datasets.length === 0 && documents.length === 0) {
      return { ok: false, status: 409, error: "This session has no usable stored data." };
    }

    const allTables = datasets.flatMap((d) => d.tables);

    let resolvedConfig: ResolvedDashboardConfigShape;
    try {
      const rawConfig = await combinedDashboardClient.generateCombinedDashboard(
        datasets,
        documents,
        { adminIntent: trimmed },
      );

      const resolvedInsights = resolveInsightMetrics(rawConfig.insights, allTables);
      resolvedConfig = {
        ...rawConfig,
        insights: resolvedInsights,
      };
    } catch (error: unknown) {
      if (error instanceof CombinedDashboardBillingError) {
        return { ok: false, status: 503, error: error.message };
      }

      if (error instanceof CombinedDashboardValidationError) {
        payload.logger.warn(`Combined edit failed validation, retrying with stricter instruction: ${error.message}`);
        try {
          const rawConfig = await combinedDashboardClient.generateCombinedDashboard(
            datasets,
            documents,
            { adminIntent: trimmed, stricterInstruction: `The previous response failed validation with: ${error.message}. Return the complete valid configuration matching the schema.` },
          );
          const resolvedInsights = resolveInsightMetrics(rawConfig.insights, allTables);
          resolvedConfig = {
            ...rawConfig,
            insights: resolvedInsights,
          };
        } catch (retryError: unknown) {
          if (retryError instanceof CombinedDashboardBillingError) {
            return { ok: false, status: 503, error: retryError.message };
          }
          const message = retryError instanceof Error ? retryError.message : String(retryError);
          await persistTurn("error", { error: message });
          return { ok: false, status: 502, error: message };
        }
      } else {
        const message = error instanceof Error ? error.message : String(error);
        await persistTurn("error", { error: message });
        return { ok: false, status: 502, error: message };
      }
    }

    const currentOverview =
      session.overview && typeof session.overview === "object" ? session.overview : {};
    const updatedOverview = {
      ...currentOverview,
      config: resolvedConfig,
      // Same provenance rule as applyToDataset above: a combined-session
      // edit supersedes whatever pipeline produced the previous overview,
      // and must clear any "initial_fallback" marker so upgrade-polling
      // stops.
      configSource: CONFIG_SOURCE.promptEdit,
    };

    await payload.update({
      collection: "sessions",
      id: sessionId,
      data: {
        name: sessionName?.trim() || session.name,
        overview: updatedOverview,
        status: "ready",
      },
    });

    invalidateCache("session");

    await persistTurn(
      "edit_applied",
      { configTitle: resolvedConfig.title },
      "session",
      sessionId,
    );

    return {
      ok: true,
      sessionId,
      kind: "applied",
      targetKind: "session",
      version: 1,
    };
  };

  if (datasetIds.length === 1 && documentIds.length === 0) {
    return applyToDataset(datasetIds[0]!);
  }

  if (documentIds.length === 1 && datasetIds.length === 0) {
    return applyToDocument(documentIds[0]!);
  }

  if (datasetIds.length + documentIds.length === 0) {
    return { ok: false, status: 409, error: "This session has no sources yet." };
  }

  const sources: { sourceKind: "dataset" | "document"; sourceId: string; sourceName: string }[] = [];

  for (const id of datasetIds) {
    try {
      const dataset = await payload.findByID({ collection: "datasets", id, depth: 0 });
      sources.push({ sourceKind: "dataset", sourceId: id, sourceName: dataset.name });
    } catch {
      // Skip
    }
  }

  for (const id of documentIds) {
    try {
      const document = await payload.findByID({ collection: "documents", id, depth: 0 });
      sources.push({ sourceKind: "document", sourceId: id, sourceName: document.name });
    } catch {
      // Skip
    }
  }

  if (sources.length === 0) {
    return { ok: false, status: 409, error: "This session's sources could not be loaded." };
  }

  let targetDecision;

  try {
    targetDecision = await targetClient.resolveTarget(sources, trimmed);
  } catch (error: unknown) {
    if (error instanceof SessionEditTargetBillingError) {
      return { ok: false, status: 503, error: error.message };
    }

    const message = error instanceof Error ? error.message : String(error);
    await persistTurn("error", { error: message });
    return { ok: false, status: 502, error: message };
  }

  if (targetDecision.outcome === "needs_clarification") {
    await persistTurn("needs_clarification", { question: targetDecision.question });
    return { ok: true, sessionId, kind: "needs_clarification", question: targetDecision.question };
  }

  if (targetDecision.outcome === "combined_session") {
    return applyToCombinedSession(targetDecision.sessionName);
  }

  if (targetDecision.sourceKind === "dataset") {
    return applyToDataset(targetDecision.sourceId);
  }

  return applyToDocument(targetDecision.sourceId);
};

export { ClaudeEditBillingError, ClaudeDocumentEditBillingError, CombinedDashboardBillingError };
