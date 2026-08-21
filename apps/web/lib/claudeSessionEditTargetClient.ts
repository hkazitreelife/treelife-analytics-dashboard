import {
  isClaudeBillingRejection,
  resolveClaudeModel,
  sessionEditTargetSchema,
  sessionEditTargetToolSchema,
  type SessionEditTargetShape,
} from "@analytics/shared";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Prompt 15.0 Part 2 item 4: "edit should apply to whichever source(s) the
 * request clearly targets, or ask for clarification if ambiguous rather
 * than guessing." This client's only job is that one classification --
 * which source, or a clarifying question -- never the edit itself. Once a
 * target is resolved, lib/sessionEdit.ts delegates to the exact same
 * runPromptEdit/runDocumentPromptEdit the single-source path already uses,
 * so the actual editing logic is never duplicated or reimplemented here.
 *
 * Chat-tier model (ANTHROPIC_MODEL/_RETRY_MODEL): this is a lightweight
 * classification, not new-insight generation.
 */

export class SessionEditTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionEditTargetError";
  }
}

export class SessionEditTargetBillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionEditTargetBillingError";
  }
}

const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_RETRY_MODEL = "claude-haiku-5";

const SYSTEM_INSTRUCTION = [
  "A session groups several sources (datasets and/or documents). An admin",
  "has asked for an edit/reshape.",
  "",
  "You must call the emit_edit_target tool exactly once.",
  "",
  "Outcomes:",
  "1. If the request asks for a combined overview, a merge/combination of sources,",
  "   an executive dashboard across the session, or to create/edit the unified session",
  "   dashboard itself (e.g. 'make a combined dashboard', 'Executive Overview should be a combined dashboard of Dataset X and Document Y'),",
  "   return { outcome: 'combined_session', sessionName: 'optional extracted title' }.",
  "2. If the request clearly names or implies exactly ONE single source (by its name,",
  "   by 'the spreadsheet'/'the dashboard' when only one dataset exists, by",
  "   'the summary'/'the deck'/'the memo' when only one document exists, or by",
  "   content only one source could plausibly have), return",
  "   { outcome: 'target', sourceKind, sourceId } using the exact id given to you, verbatim.",
  "3. If the request is genuinely ambiguous and does not ask for a combined session,",
  "   return { outcome: 'needs_clarification', question } with a short, specific question",
  "   listing the real source names as options -- never guess a target when it is genuinely ambiguous.",
].join("\n");

export type SessionEditTargetSourceInput = {
  sourceKind: "dataset" | "document";
  sourceId: string;
  sourceName: string;
};

export type SessionEditTargetClient = {
  primaryModel: string;
  retryModelName: string;
  resolveTarget: (
    sources: SessionEditTargetSourceInput[],
    prompt: string,
  ) => Promise<SessionEditTargetShape>;
};

export const createSessionEditTargetClient = (
  apiKey: string,
  model: string = process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL,
  retryModel: string | undefined = process.env.ANTHROPIC_RETRY_MODEL ?? DEFAULT_RETRY_MODEL,
): SessionEditTargetClient => {
  if (!apiKey) {
    throw new SessionEditTargetError("Missing ANTHROPIC_API_KEY. Set it in apps/web/.env.local.");
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
    resolveTarget: async (sources, prompt) => {
      const userContent = [
        "Sources in this session:",
        JSON.stringify(sources),
        "",
        "Admin's edit request:",
        prompt,
      ].join("\n");

      let rawInput: unknown = null;

      // Same reasoning as claudeChatClient.ts: this client had no
      // OpenRouter branch at all until now, so with an OpenRouter-format
      // key, every edit-target resolution call was failing outright by
      // calling Anthropic's native SDK straight at ANTHROPIC_BASE_URL. The
      // prompt schema is serialized from sessionEditTargetToolSchema
      // (already imported), not hand-copied, so it can't drift from the
      // real validator.
      if (apiKey.startsWith("sk-or-") || process.env.ANTHROPIC_BASE_URL?.includes("openrouter")) {
        try {
          const { callLlmCompletion } = await import("./openRouterClient");
          const llmRes = await callLlmCompletion({
            apiKey,
            model: resolvedModel,
            system: `${SYSTEM_INSTRUCTION}\n\nYou must return ONLY valid JSON (no markdown fences, no extra keys) matching this exact JSON Schema: ${JSON.stringify(sessionEditTargetToolSchema)}`,
            userPrompt: userContent,
            maxTokens: 1000,
          });

          rawInput = llmRes.jsonContent;
        } catch (error: unknown) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new SessionEditTargetError(`Edit-target request failed on model "${model}": ${detail}`);
        }

        if (!rawInput) {
          throw new SessionEditTargetError(
            `Model "${model}" did not return parseable JSON for the edit target.`,
          );
        }
      } else {
        let response;

        try {
          response = await client.messages.create({
            model: resolvedModel,
            max_tokens: 1_000,
            system: SYSTEM_INSTRUCTION,
            tools: [
              {
                name: "emit_edit_target",
                description: "Decide which one source this edit request targets, or ask for clarification.",
                input_schema: sessionEditTargetToolSchema,
              },
            ],
            tool_choice: { type: "tool", name: "emit_edit_target" },
            messages: [{ role: "user", content: userContent }],
          });
        } catch (error: unknown) {
          const detail = error instanceof Error ? error.message : String(error);
          const status =
            typeof error === "object" && error !== null && "status" in error
              ? Number((error as { status: unknown }).status)
              : undefined;

          if (isClaudeBillingRejection(detail, status)) {
            throw new SessionEditTargetBillingError(
              `BILLING, QUOTA OR RATE-LIMIT REJECTION from model "${model}". Provider detail: ${detail}`,
            );
          }

          throw new SessionEditTargetError(`Edit-target request failed on model "${model}": ${detail}`);
        }

        const toolUse = response.content.find(
          (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
        );

        if (!toolUse) {
          throw new SessionEditTargetError(
            `Model "${model}" did not call emit_edit_target. Stop reason: ${response.stop_reason ?? "unknown"}.`,
          );
        }

        rawInput = toolUse.input;
      }

      const result = sessionEditTargetSchema.safeParse(rawInput);

      if (!result.success) {
        throw new SessionEditTargetError(
          `Edit target from model "${model}" failed schema validation: ${JSON.stringify(result.error.issues)}`,
        );
      }

      if (result.data.outcome === "target") {
        const { sourceKind, sourceId } = result.data;
        const matches = sources.some(
          (s) => s.sourceKind === sourceKind && s.sourceId === sourceId,
        );

        if (!matches) {
          throw new SessionEditTargetError(
            `Model "${model}" named a target not among this session's real sources: ${JSON.stringify(result.data)}`,
          );
        }
      }

      return result.data;
    },
  };
};
