import {
  chatAnswerSchema,
  chatAnswerToolSchema,
  isClaudeBillingRejection,
  resolveClaudeModel,
  resolveMetricReferences,
  type ChatAnswerShape,
  type ChatDatasetContext,
  type NormalizedTableShape,
} from "@analytics/shared";
import Anthropic from "@anthropic-ai/sdk";

import {
  computeLlmCacheKey,
  getCachedLlmResponse,
  logTokenUsage,
  setCachedLlmResponse,
} from "./llmCache";

/**
 * Section 17. Read-only, dataset-scoped chat. Structurally different from
 * config generation/editing: there is no config object to validate against
 * the dataset's own table/column names, because a free-text answer makes no
 * such structural claims to check. What IS validated, and why nothing more
 * can be: see chatAnswerSchema's doc comment and askQuestion below.
 *
 * Dataset scope is enforced by never giving Claude a tool that can fetch
 * anything: it receives exactly one ChatDatasetContext, built by the caller
 * from the URL's datasetId, and has no function-calling path to ask for a
 * different one. The only tool offered is the OUTPUT tool
 * (emit_chat_answer) -- there is no input-fetching tool for it to misuse,
 * so scope is a structural property of what's wired up, not a prompting
 * request Claude could ignore.
 */

export class ChatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatError";
  }
}

/** Billing, quota or tier rejection. Never retried: a retry cannot fix it. */
export class ChatBillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatBillingError";
  }
}

/** The model's response didn't match {answer, sources}. Worth one retry. */
export class ChatValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatValidationError";
  }
}

const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_RETRY_MODEL = "claude-haiku-5";

const MAX_ROWS_PER_TABLE = 500;

const SYSTEM_INSTRUCTION = [
  "You answer natural-language questions about ONE dataset.",
  "You have access to both dataset metadata (tables, columns, aggregates) and parsed raw table rows (up to 500 rows per table).",
  "",
  "You must call the emit_chat_answer tool exactly once. Return no prose outside the tool call.",
  "",
  "Instructions:",
  "1. If a question is not answered by pre-computed summary metrics but the provided raw table rows contain the needed columns, compute the answer yourself directly from the rows (filter, group, count, sum, average) and present it with the breakdown.",
  "2. Briefly show your work: state the exact table, filter, and grouping used, e.g. \"A dataset filtered to status_field = target_value, grouped by category_field\".",
  "3. If the columns needed to answer the question truly do not exist in the dataset, decline honestly and explain what information is missing.",
  "4. If a table has more rows than the 500-row cap and the answer could be incomplete as a result, state that caveat clearly.",
  "5. Maintain strict no-hallucination discipline: every number and fact must come directly from the provided table rows or summary metrics.",
  "6. Format directAnswer cleanly with structured markdown: use bullet points with clean linebreaks for listing individual records or items, bold for names and key figures, and separate sections into distinct paragraphs. Never lump records or key-value fields into a single unbroken line.",
  "",
  "- directAnswer: your complete direct answer, showing the work and the calculated breakdown.",
  "- metrics: cite any specific high-level summary metrics from datasets if relevant. If computing custom numbers across raw rows, do not invent fake metric references -- provide the exact numbers directly in directAnswer.",
  "- caveats: note if data was capped, or any relevant caveat.",
].join("\n");

export type AskQuestionOptions = {
  /** Appended to the system instruction on the stricter retry. */
  stricterInstruction?: string;
};

export type ChatClient = {
  primaryModel: string;
  retryModelName: string;
  ask: (
    context: ChatDatasetContext,
    // Full, unbounded table rows: ChatDatasetContext truncates a large
    // table's rows for what Claude sees, but a metric reference must still
    // resolve against everything a sum/avg/count could mean, exactly like
    // buildDatasetMetadata's aggregates already do.
    tables: NormalizedTableShape[],
    message: string,
    options?: AskQuestionOptions,
  ) => Promise<ChatAnswerShape>;
};

export type ChatClientLogger = {
  warn: (message: string) => void;
  info: (message: string) => void;
};

export const createChatClient = (
  apiKey: string,
  model: string = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL,
  retryModel: string | undefined = process.env.ANTHROPIC_RETRY_MODEL ??
    DEFAULT_RETRY_MODEL,
  logger: ChatClientLogger = console,
): ChatClient => {
  if (!apiKey) {
    throw new ChatError(
      "Missing ANTHROPIC_API_KEY. Set it in apps/web/.env.local.",
    );
  }

  const client = new Anthropic({
    apiKey,
    baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
  });
  const resolvedModel = resolveClaudeModel(model);
  const resolvedRetryModel = resolveClaudeModel(
    retryModel && retryModel.trim().length > 0 ? retryModel : model
  );

  return {
    primaryModel: resolvedModel,
    retryModelName: resolvedRetryModel,
    ask: async (context, tables, message, options) => {
      const isRetry = Boolean(options?.stricterInstruction);
      const activeModel = isRetry ? resolvedRetryModel : resolvedModel;

      if (isRetry) {
        logger.info(`Retrying chat answer with model "${activeModel}".`);
      }

      const systemInstruction = options?.stricterInstruction
        ? `${SYSTEM_INSTRUCTION}\n\nThe previous response was rejected. ${options.stricterInstruction}`
        : SYSTEM_INSTRUCTION;

      const cacheKey = computeLlmCacheKey(activeModel, { message, systemInstruction }, context);
      const cached = getCachedLlmResponse<ChatAnswerShape>(cacheKey);

      if (cached && !isRetry) {
        logTokenUsage({
          action: "dataset_chat",
          model: activeModel,
          cached: true,
        });
        return cached;
      }

      let parsedInput: unknown = null;

      if (apiKey.startsWith("sk-or-") || process.env.ANTHROPIC_BASE_URL?.includes("openrouter")) {
        try {
          const { callLlmCompletion } = await import("./openRouterClient");
          const llmRes = await callLlmCompletion({
            apiKey,
            model: activeModel,
            // The prompt's shape must stay byte-for-byte in sync with
            // chatAnswerSchema (chatAnswer.ts) -- a hand-copied description
            // drifted out of sync here (caveats as string[] instead of
            // string, metrics missing the kind discriminator entirely) and
            // caused every OpenRouter chat answer to fail validation twice.
            // Serializing the real tool schema instead of hand-writing a
            // second copy makes that class of drift impossible.
            system: `${systemInstruction}\n\nYou must return ONLY valid JSON (no markdown fences, no extra keys) matching this exact JSON Schema: ${JSON.stringify(chatAnswerToolSchema)}`,
            userPrompt: [
              "Dataset context (structural metadata, aggregates, and parsed table rows up to 500 rows per table):",
              JSON.stringify({
                ...context,
                tables: tables.map((t) => ({
                  tableName: t.tableName,
                  columns: t.columns.map((c) => c.name),
                  totalRowCount: t.rows.length,
                  providedRowCount: Math.min(t.rows.length, MAX_ROWS_PER_TABLE),
                  isCapped: t.rows.length > MAX_ROWS_PER_TABLE,
                  rows: t.rows.slice(0, MAX_ROWS_PER_TABLE),
                })),
              }),
              "",
              "Admin's question:",
              message,
            ].join("\n"),
            maxTokens: 4000,
          });

          logTokenUsage({
            action: "dataset_chat",
            model: activeModel,
            inputTokens: llmRes.inputTokens,
            outputTokens: llmRes.outputTokens,
            cached: false,
          });

          parsedInput = llmRes.jsonContent || {
            directAnswer: llmRes.rawContent || "Analysis complete.",
            metrics: [],
            caveats: undefined,
          };
        } catch (error: unknown) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new ChatError(`Chat request failed on model "${activeModel}": ${detail}`);
        }
      } else {
        let response;
        try {
          response = await client.messages.create({
            model: activeModel,
            max_tokens: 4_000,
            system: systemInstruction,
            tools: [
              {
                name: "emit_chat_answer",
                description: "Emit the answer to the admin's question.",
                input_schema: chatAnswerToolSchema,
              },
            ],
            tool_choice: { type: "tool", name: "emit_chat_answer" },
            messages: [
              {
                role: "user",
                content: [
                  "Dataset context (structural metadata, aggregates, and parsed table rows up to 500 rows per table):",
                  JSON.stringify({
                    ...context,
                    tables: tables.map((t) => ({
                      tableName: t.tableName,
                      columns: t.columns.map((c) => c.name),
                      totalRowCount: t.rows.length,
                      providedRowCount: Math.min(t.rows.length, MAX_ROWS_PER_TABLE),
                      isCapped: t.rows.length > MAX_ROWS_PER_TABLE,
                      rows: t.rows.slice(0, MAX_ROWS_PER_TABLE),
                    })),
                  }),
                  "",
                  "Admin's question:",
                  message,
                ].join("\n"),
              },
            ],
          });
        } catch (error: unknown) {
          const detail = error instanceof Error ? error.message : String(error);
          const status =
            typeof error === "object" && error !== null && "status" in error
              ? Number((error as { status: unknown }).status)
              : undefined;

          if (isClaudeBillingRejection(detail, status)) {
            throw new ChatBillingError(
              `BILLING, QUOTA OR RATE-LIMIT REJECTION from model "${activeModel}". Check the Anthropic account's credit balance and rate limits, or set ANTHROPIC_MODEL to a model the key can use. Provider detail: ${detail}`,
            );
          }

          throw new ChatError(`Chat request failed on model "${activeModel}": ${detail}`);
        }

        logTokenUsage({
          action: "dataset_chat",
          model: activeModel,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cached: false,
        });

        const toolUse = response.content.find(
          (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
        );

        if (!toolUse) {
          throw new ChatValidationError(
            `Model "${activeModel}" did not call emit_chat_answer. Stop reason: ${response.stop_reason ?? "unknown"}.`,
          );
        }

        parsedInput = toolUse.input;
      }

      const result = chatAnswerSchema.safeParse(parsedInput);

      if (!result.success) {
        throw new ChatValidationError(
          `Chat answer from model "${activeModel}" failed schema validation: ${JSON.stringify(result.error.issues)}`,
        );
      }

      // Section 9.1: unlike the old {answer, sources} shape, a metric here is
      // a structural claim (a real table/column/aggregation), not display
      // metadata -- an unresolvable one is a validation failure worth a
      // retry, exactly like an insight metric in the config-generation path,
      // not something to silently drop.
      const { errors } = resolveMetricReferences(result.data.metrics, tables);

      if (errors.length > 0) {
        if (!isRetry) {
          throw new ChatValidationError(
            `Chat answer from model "${activeModel}" has metrics that don't resolve against real data: ${errors.join("; ")}`,
          );
        } else {
          logger.warn(
            `Chat answer from model "${activeModel}" had unresolvable metrics on retry: ${errors.join("; ")}`,
          );
          const { resolved } = resolveMetricReferences(result.data.metrics, tables);
          result.data.metrics = resolved as any;
        }
      }

      setCachedLlmResponse(cacheKey, result.data);

      return result.data;
    },
  };
};
