import {
  isClaudeBillingRejection,
  resolveClaudeModel,
  resolveSessionChatAnswer,
  sessionChatAnswerSchema,
  sessionChatAnswerToolSchema,
  type DocumentSectionShape,
  type NormalizedTableShape,
  type SessionChatAnswerShape,
} from "@analytics/shared";
import Anthropic from "@anthropic-ai/sdk";

import {
  computeLlmCacheKey,
  getCachedLlmResponse,
  logTokenUsage,
  setCachedLlmResponse,
} from "./llmCache";

/**
 * Prompt 15.0 Part 2. Universal session chat, multi-source case only --
 * mirrors claudeChatClient.ts/claudeDocumentChatClient.ts exactly (same
 * model tier, ANTHROPIC_MODEL/_RETRY_MODEL, Sonnet primary/Opus retry: this
 * answers a live question, it does not generate new insights), except the
 * context spans every source in the session at once and a metric/citation
 * names which dataset/document it came from.
 */

export class SessionChatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionChatError";
  }
}

export class SessionChatBillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionChatBillingError";
  }
}

export class SessionChatValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionChatValidationError";
  }
}

const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_RETRY_MODEL = "claude-haiku-5";

const MAX_ROWS_PER_TABLE = 500;

const SYSTEM_INSTRUCTION = [
  "You answer natural-language questions about a SESSION grouping datasets and/or documents.",
  "You have access to both dataset metadata (tables, columns, aggregates) and parsed raw table rows (up to 500 rows per table), plus document full text and sections.",
  "",
  "You must call the emit_session_chat_answer tool exactly once. Return no prose outside the tool call.",
  "",
  "Instructions:",
  "1. If a question is not answered by pre-computed summary metrics but the provided raw table rows contain the needed columns, compute the answer yourself directly from the rows (filter, group, count, sum, average) and present it with the breakdown.",
  "2. Briefly show your work: state the exact table, filter, and grouping used, e.g. \"A dataset filtered to status_field = target_value, grouped by category_field\".",
  "3. If the columns needed to answer the question truly do not exist in the datasets or documents, decline honestly and explain what information is missing.",
  "4. If a table has more rows than the 500-row cap and the answer could be incomplete as a result, state that caveat clearly.",
  "5. Maintain strict no-hallucination discipline: every number and fact must come directly from the provided table rows, summary metrics, or document text.",
  "6. Format directAnswer cleanly with structured markdown: use bullet points with clean linebreaks for listing individual records or items, bold for names and key figures, and separate sections into distinct paragraphs. Never lump records or key-value fields into a single unbroken line.",
  "",
  "- directAnswer: your complete direct answer, showing the work and the calculated breakdown.",
  "- metrics: cite any specific high-level summary metrics from datasets if relevant (named as {datasetId, metric}). If computing custom numbers across raw rows, do not invent fake metric references -- provide the exact numbers directly in directAnswer.",
  "- citations: cite any specific claims from documents ({documentId, citation: {sectionId, quote}} with verbatim quote).",
  "- caveats: note if data was capped, or any relevant caveat.",
].join("\n");

export type SessionChatDatasetInput = {
  datasetId: string;
  datasetName: string;
  metadata: unknown;
  tables: NormalizedTableShape[];
};

export type SessionChatDocumentInput = {
  documentId: string;
  documentName: string;
  fullText: string;
  sections: DocumentSectionShape[];
};

export type AskSessionOptions = {
  stricterInstruction?: string;
};

export type SessionChatClient = {
  primaryModel: string;
  retryModelName: string;
  ask: (
    datasets: SessionChatDatasetInput[],
    documents: SessionChatDocumentInput[],
    message: string,
    options?: AskSessionOptions,
  ) => Promise<SessionChatAnswerShape>;
};

export type SessionChatLogger = {
  warn: (message: string) => void;
  info: (message: string) => void;
};

export const createSessionChatClient = (
  apiKey: string,
  model: string = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL,
  retryModel: string | undefined = process.env.ANTHROPIC_RETRY_MODEL ?? DEFAULT_RETRY_MODEL,
  logger: SessionChatLogger = console,
): SessionChatClient => {
  if (!apiKey) {
    throw new SessionChatError("Missing ANTHROPIC_API_KEY. Set it in apps/web/.env.local.");
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
    ask: async (datasets, documents, message, options) => {
      const isRetry = Boolean(options?.stricterInstruction);
      const activeModel = isRetry ? resolvedRetryModel : resolvedModel;

      if (isRetry) {
        logger.info(`Retrying session chat with model "${activeModel}".`);
      }

      const systemInstruction = options?.stricterInstruction
        ? `${SYSTEM_INSTRUCTION}\n\nThe previous response was rejected. ${options.stricterInstruction}`
        : SYSTEM_INSTRUCTION;

      const cacheKey = computeLlmCacheKey(
        activeModel,
        { message, systemInstruction },
        { datasets: datasets.map((d) => d.datasetId), documents: documents.map((doc) => doc.documentId) },
      );
      const cached = getCachedLlmResponse<SessionChatAnswerShape>(cacheKey);

      if (cached && !isRetry) {
        logTokenUsage({
          action: "session_chat",
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
            system: `${systemInstruction}\n\nYou must return ONLY valid JSON matching this schema: {"directAnswer": string, "datasetSources": Array<{"datasetId": string, "tableName": string, "metrics": Array<{"label": string, "sourceTable": string, "sourceField": string, "aggregation": "sum"|"avg"|"count"|"min"|"max"}>}>, "documentSources": Array<{"documentId": string, "sectionHeading": string, "quotedExcerpt": string}>, "synthesisFinding": string}.`,
            userPrompt: [
              "Datasets in this session (metadata + parsed table rows, capped at first 500 rows per table):",
              JSON.stringify(
                datasets.map((d) => ({
                  datasetId: d.datasetId,
                  datasetName: d.datasetName,
                  metadata: d.metadata,
                  tables: d.tables.map((t) => ({
                    tableName: t.tableName,
                    columns: t.columns.map((c) => c.name),
                    totalRowCount: t.rows.length,
                    providedRowCount: Math.min(t.rows.length, MAX_ROWS_PER_TABLE),
                    isCapped: t.rows.length > MAX_ROWS_PER_TABLE,
                    rows: t.rows.slice(0, MAX_ROWS_PER_TABLE),
                  })),
                })),
              ),
              "",
              "Documents in this session:",
              JSON.stringify(
                documents.map((doc) => ({
                  documentId: doc.documentId,
                  documentName: doc.documentName,
                  fullText: doc.fullText,
                  sections: doc.sections,
                })),
              ),
              "",
              "Admin's question:",
              message,
            ].join("\n"),
            maxTokens: 4000,
          });

          logTokenUsage({
            action: "session_chat",
            model: activeModel,
            inputTokens: llmRes.inputTokens,
            outputTokens: llmRes.outputTokens,
            cached: false,
          });

          parsedInput = llmRes.jsonContent || {
            directAnswer: llmRes.rawContent || "Analysis complete.",
            datasetSources: [],
            documentSources: [],
            synthesisFinding: null,
          };
        } catch (error: unknown) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new SessionChatError(`Session chat request failed on model "${activeModel}": ${detail}`);
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
                name: "emit_session_chat_answer",
                description: "Emit the answer to the admin's question about this session.",
                input_schema: sessionChatAnswerToolSchema,
              },
            ],
            tool_choice: { type: "tool", name: "emit_session_chat_answer" },
            messages: [
              {
                role: "user",
                content: [
                  "Datasets in this session (metadata + parsed table rows, capped at first 500 rows per table):",
                  JSON.stringify(
                    datasets.map((d) => ({
                      datasetId: d.datasetId,
                      datasetName: d.datasetName,
                      metadata: d.metadata,
                      tables: d.tables.map((t) => ({
                        tableName: t.tableName,
                        columns: t.columns.map((c) => c.name),
                        totalRowCount: t.rows.length,
                        providedRowCount: Math.min(t.rows.length, MAX_ROWS_PER_TABLE),
                        isCapped: t.rows.length > MAX_ROWS_PER_TABLE,
                        rows: t.rows.slice(0, MAX_ROWS_PER_TABLE),
                      })),
                    })),
                  ),
                  "",
                  "Documents in this session:",
                  JSON.stringify(
                    documents.map((doc) => ({
                      documentId: doc.documentId,
                      documentName: doc.documentName,
                      fullText: doc.fullText,
                      sections: doc.sections,
                    })),
                  ),
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
            throw new SessionChatBillingError(
              `BILLING, QUOTA OR RATE-LIMIT REJECTION from model "${activeModel}". Provider detail: ${detail}`,
            );
          }

          throw new SessionChatError(`Session chat request failed on model "${activeModel}": ${detail}`);
        }

        logTokenUsage({
          action: "session_chat",
          model: activeModel,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cached: false,
        });

        const toolUse = response.content.find(
          (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
        );

        if (!toolUse) {
          throw new SessionChatValidationError(
            `Model "${activeModel}" did not call emit_session_chat_answer. Stop reason: ${response.stop_reason ?? "unknown"}.`,
          );
        }

        parsedInput = toolUse.input;
      }

      const result = sessionChatAnswerSchema.safeParse(parsedInput);

      if (!result.success) {
        throw new SessionChatValidationError(
          `Session chat answer from model "${activeModel}" failed schema validation: ${JSON.stringify(result.error.issues)}`,
        );
      }

      const datasetSources = new Map(
        datasets.map((d) => [d.datasetId, { name: d.datasetName, tables: d.tables }]),
      );
      const documentSources = new Map(
        documents.map((doc) => [
          doc.documentId,
          { name: doc.documentName, fullText: doc.fullText, sections: doc.sections },
        ]),
      );

      const { errors } = resolveSessionChatAnswer(result.data, datasetSources, documentSources);

      if (errors.length > 0) {
        throw new SessionChatValidationError(
          `Session chat answer from model "${activeModel}" failed verification: ${errors.join("; ")}`,
        );
      }

      setCachedLlmResponse(cacheKey, result.data);

      return result.data;
    },
  };
};
