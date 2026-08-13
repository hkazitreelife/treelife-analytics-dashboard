import { z } from "zod";

import { insightMetricRefSchema, resolvedInsightMetricSchema } from "./dashboardConfig";

/**
 * The chat agent's response contract, Section 17.4 / 20.9, updated by
 * Section 9.1 to the same resolved-not-typed-number pattern as insights:
 * Claude names which real column/aggregation it's citing via `metrics`, it
 * never writes the number itself. This does add one structural
 * cross-reference to validate beyond the original "just check shape" design
 * -- see findUnresolvableMetrics in claudeConfigContract.ts, reused as-is
 * from the insight path -- but the answer text itself is still unverifiable
 * prose, same as before.
 *
 * `caveats` is optional free text for a caller-relevant note the resolved
 * number doesn't otherwise carry (e.g. "this table's TOTAL row was excluded
 * from this figure").
 */
export const chatAnswerSchema = z
  .object({
    directAnswer: z.string().min(1),
    metrics: z.array(insightMetricRefSchema),
    caveats: z.string().optional(),
  })
  .strict();

/** chatAnswerSchema with every metric resolved to a real number. */
export const resolvedChatAnswerSchema = z
  .object({
    directAnswer: z.string().min(1),
    metrics: z.array(resolvedInsightMetricSchema),
    caveats: z.string().optional(),
  })
  .strict();

export type ChatAnswerShape = z.infer<typeof chatAnswerSchema>;
export type ResolvedChatAnswerShape = z.infer<typeof resolvedChatAnswerSchema>;

/** The emit_chat_answer tool's input schema, mirroring chatAnswerSchema exactly. */
export const chatAnswerToolSchema = {
  type: "object" as const,
  properties: {
    directAnswer: { type: "string" },
    metrics: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          sourceTable: { type: "string" },
          sourceField: { type: "string" },
          aggregation: {
            type: "string",
            enum: ["sum", "avg", "count", "min", "max"],
          },
        },
        required: ["label", "sourceTable", "sourceField", "aggregation"],
        additionalProperties: false,
      },
    },
    caveats: { type: "string" },
  },
  required: ["directAnswer", "metrics"],
  additionalProperties: false,
};
