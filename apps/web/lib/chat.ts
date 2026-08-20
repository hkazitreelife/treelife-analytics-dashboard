import {
  buildChatContext,
  resolveMetricReferences,
  type ChatAnswerShape,
  type NormalizedTableShape,
  type ResolvedMetric,
} from "@analytics/shared";
import type { Payload } from "payload";

import {
  ChatBillingError,
  ChatValidationError,
  type ChatClient,
} from "./claudeChatClient";

/**
 * Section 17.3's chat flow, factored out of the route handler for the same
 * reason lib/promptEdit.ts is: testable with a stubbed chatClient, no real
 * Claude call, no real spend.
 *
 * Dataset scope (Section 17.2.5, 17.3.1/2) is enforced structurally, not by
 * trusting the model: `datasetId` -- the URL param, passed in by the route,
 * never anything derived from `message` -- is the ONLY id ever used to read
 * from Payload. `message` is opaque free text handed to Claude for it to
 * answer from the context already built; nothing in this function branches
 * on its content, and Claude has no tool that could fetch a different
 * dataset even if the message asked it to.
 */

const MAX_MESSAGE_LENGTH = 2000;

export type ChatDeps = {
  payload: Payload;
  chatClient: ChatClient;
};

export type ChatResult =
  | {
      ok: true;
      datasetId: string;
      directAnswer: string;
      metrics: ResolvedMetric[];
      caveats?: string;
    }
  | { ok: false; status: number; error: string };

type StoredDatasetData = {
  tables?: NormalizedTableShape[];
  relationships?: unknown[];
};

const isOutputQualityFailure = (error: unknown): boolean =>
  error instanceof ChatValidationError;

export const runChatQuestion = async (
  datasetId: string,
  message: string,
  deps: ChatDeps,
): Promise<ChatResult> => {
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

  let dataset;

  try {
    // The ONLY read of Payload's datasets collection in this function, and
    // it uses `datasetId` -- the URL param -- exclusively. `message` is
    // never inspected for an id, a table name, or anything else that could
    // redirect this lookup.
    dataset = await payload.findByID({
      collection: "datasets",
      id: datasetId,
      depth: 0,
    });
  } catch {
    return { ok: false, status: 404, error: "Dataset not found." };
  }

  const stored = dataset.data as StoredDatasetData | null;
  const tables = stored?.tables ?? [];

  if (tables.length === 0) {
    return {
      ok: false,
      status: 409,
      error: "This dataset has no stored data yet. Nothing to answer from.",
    };
  }

  const context = buildChatContext(
    String(datasetId),
    dataset.name,
    tables,
    stored?.relationships ?? [],
  );

  const attempt = async (stricterInstruction?: string) =>
    chatClient.ask(
      context,
      tables,
      trimmedMessage,
      stricterInstruction ? { stricterInstruction } : undefined,
    );

  /**
   * The client already validated that every metric resolves (see
   * claudeChatClient.ts's ask); this resolves them into the actual numbers,
   * same "validate inside the client, resolve/re-check at the call site"
   * split as the config-generation and prompt-edit paths. errors should
   * always be empty here -- re-checked anyway rather than trusted blindly.
   */
  const finalize = (result: ChatAnswerShape): ChatResult => {
    const { resolved, errors } = resolveMetricReferences(result.metrics, tables);

    if (errors.length > 0) {
      payload.logger.warn(
        `Chat answer's metrics had resolution issues (omitting unresolved): ${errors.join("; ")}`,
      );
    }

    return {
      ok: true,
      datasetId: String(datasetId),
      directAnswer: result.directAnswer,
      metrics: resolved,
      caveats: result.caveats,
    };
  };

  try {
    return finalize(await attempt());
  } catch (firstError: unknown) {
    if (!isOutputQualityFailure(firstError)) {
      if (firstError instanceof ChatBillingError) {
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
      `Chat answer failed validation, retrying once with stricter instruction on model "${chatClient.retryModelName}". Violation: ${violation}`,
    );

    const stricter = [
      `The exact violation was: ${violation}`,
      "Call emit_chat_answer exactly once, with a non-empty directAnswer",
      "string and a metrics array (it may be empty, but must be an array).",
      "Every metric needs a kind. kind:\"aggregate\" needs sourceTable/",
      "sourceField (real table/column names, verbatim) and an aggregation",
      "suiting that column's type. kind:\"row\" needs sourceTable/labelColumn/",
      "labelValue/valueColumn instead, no aggregation field -- use it for a",
      "table with preferRowAddressing:true or a row listed in",
      "namedFigureRows. Do not include a `value` field on any metric.",
    ].join(" ");

    try {
      return finalize(await attempt(stricter));
    } catch (secondError: unknown) {
      if (secondError instanceof ChatBillingError) {
        return { ok: false, status: 503, error: secondError.message };
      }

      const detail =
        secondError instanceof Error
          ? secondError.message
          : String(secondError);

      return {
        ok: false,
        status: 502,
        error: `Chat answer failed validation twice, second attempt used model "${chatClient.retryModelName}". First violation: ${violation} Second failure: ${detail}`,
      };
    }
  }
};
