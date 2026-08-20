import { z } from "zod";

import {
  insightMetricJsonSchema,
  insightMetricRefSchema,
  resolvedInsightMetricSchema,
} from "./dashboardConfig";
import { documentChatCitationSchema } from "./documentChatAnswer";

/**
 * Prompt 15.0 Part 2. A session's universal chat answer, for a multi-source
 * session -- the single-source case delegates straight to the existing
 * chatAnswerSchema/documentChatAnswerSchema paths unchanged (lib/
 * sessionChat.ts), so this schema only exists for the case where Claude may
 * draw on more than one dataset and/or document at once.
 *
 * Unlike sessionSynthesis.ts's finding schema, a chat answer does NOT
 * require pairing a metric with a citation -- "how many rows does the xlsx
 * have" only ever needs a metric, "what does the memo say about X" only
 * ever needs a citation. Each array may be empty independently; the answer
 * itself (directAnswer) is the only required content.
 */

export const sessionChatMetricSchema = z
  .object({
    datasetId: z.string().min(1),
    metric: insightMetricRefSchema,
  })
  .strict();

export const sessionChatCitationSchema = z
  .object({
    documentId: z.string().min(1),
    citation: documentChatCitationSchema,
  })
  .strict();

export const sessionChatAnswerSchema = z
  .object({
    directAnswer: z.string().min(1),
    metrics: z.array(sessionChatMetricSchema),
    citations: z.array(sessionChatCitationSchema),
    caveats: z.string().optional(),
  })
  .strict();

export type SessionChatMetricShape = z.infer<typeof sessionChatMetricSchema>;
export type SessionChatCitationShape = z.infer<typeof sessionChatCitationSchema>;
export type SessionChatAnswerShape = z.infer<typeof sessionChatAnswerSchema>;

export const resolvedSessionChatMetricSchema = z
  .object({
    datasetId: z.string().min(1),
    datasetName: z.string().min(1),
    metric: resolvedInsightMetricSchema,
  })
  .strict();

export const resolvedSessionChatAnswerSchema = z
  .object({
    directAnswer: z.string().min(1),
    metrics: z.array(resolvedSessionChatMetricSchema),
    citations: z.array(sessionChatCitationSchema.extend({ documentName: z.string().min(1) })),
    caveats: z.string().optional(),
  })
  .strict();

export type ResolvedSessionChatMetricShape = z.infer<typeof resolvedSessionChatMetricSchema>;
export type ResolvedSessionChatAnswerShape = z.infer<typeof resolvedSessionChatAnswerSchema>;

export const sessionChatAnswerToolSchema = {
  type: "object" as const,
  properties: {
    directAnswer: { type: "string" as const },
    metrics: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          datasetId: { type: "string" as const },
          metric: insightMetricJsonSchema,
        },
        required: ["datasetId", "metric"],
        additionalProperties: false,
      },
    },
    citations: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          documentId: { type: "string" as const },
          citation: {
            type: "object" as const,
            properties: {
              sectionId: { type: "string" as const },
              quote: { type: "string" as const },
            },
            required: ["sectionId", "quote"],
            additionalProperties: false,
          },
        },
        required: ["documentId", "citation"],
        additionalProperties: false,
      },
    },
    caveats: { type: "string" as const },
  },
  required: ["directAnswer", "metrics", "citations"],
  additionalProperties: false,
};

/**
 * Multi-source edit target resolution. Given a session's known sources and
 * a free-text edit request, Claude either names exactly one target (by id
 * and kind) or asks for clarification -- never guesses silently.
 */
export const sessionEditTargetSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("target"),
      sourceKind: z.enum(["dataset", "document"]),
      sourceId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("combined_session"),
      sessionName: z.string().optional(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("needs_clarification"),
      question: z.string().min(1),
    })
    .strict(),
]);

export type SessionEditTargetShape = z.infer<typeof sessionEditTargetSchema>;

export const sessionEditTargetToolSchema = {
  type: "object" as const,
  properties: {
    outcome: {
      type: "string" as const,
      enum: ["target", "combined_session", "needs_clarification"],
    },
    sourceKind: { type: "string" as const, enum: ["dataset", "document"] },
    sourceId: { type: "string" as const },
    sessionName: { type: "string" as const },
    question: { type: "string" as const },
  },
  required: ["outcome"],
  additionalProperties: false,
};
