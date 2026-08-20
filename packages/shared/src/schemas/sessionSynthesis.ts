import { z } from "zod";

import {
  insightMetricJsonSchema,
  insightMetricRefSchema,
  resolvedInsightMetricSchema,
} from "./dashboardConfig";
import { documentChatCitationSchema } from "./documentChatAnswer";

/**
 * Session synthesis (ad hoc, requested mid-session -- not in
 * project_requirement.md, so this file doesn't cite a spec section the way
 * the rest of this codebase's schemas do).
 *
 * A Session groups two or more files uploaded together in one landing-page
 * batch. Each source keeps its own full, unchanged pipeline (a dataset still
 * gets a real config, a document still gets a real summary) -- this is only
 * the contract for the extra layer on top: candidate connections BETWEEN
 * sources.
 *
 * The one rule that makes this different from every other Claude output in
 * this app: a finding is not "prose with metrics" (dashboardConfig's
 * insights) or "prose with citations" (chatAnswer/documentChatAnswer) --
 * every finding here MUST carry both a resolved-metric reference (Section
 * 9.1's discipline, into a NAMED dataset) AND a verified-quote reference
 * (Section 10.2's discipline, into a NAMED document). Neither side is
 * optional. A finding with only one side is not a smaller, weaker
 * cross-source connection -- it isn't a cross-source connection at all, so
 * the schema does not allow it to exist as one. An empty findings array is
 * the correct, expected output when nothing real connects the sources; it
 * is not a failure state.
 */

export const sessionFindingSchema = z
  .object({
    finding: z.string().min(1),
    whyItMatters: z.string().min(1),
    // Which of the session's datasets this finding's metric belongs to --
    // required because a session can group more than one dataset, and
    // resolveMetricReferences resolves against exactly one dataset's tables
    // at a time.
    datasetId: z.string().min(1),
    metric: insightMetricRefSchema,
    // Which of the session's documents this finding's quote belongs to,
    // same reasoning.
    documentId: z.string().min(1),
    citation: documentChatCitationSchema,
  })
  .strict();

export const sessionSynthesisOutputSchema = z
  .object({
    findings: z.array(sessionFindingSchema),
  })
  .strict();

export type SessionFindingShape = z.infer<typeof sessionFindingSchema>;
export type SessionSynthesisOutputShape = z.infer<typeof sessionSynthesisOutputSchema>;

/** sessionFindingSchema with the metric resolved to a real number, plus source names for display. */
export const resolvedSessionFindingSchema = z
  .object({
    finding: z.string().min(1),
    whyItMatters: z.string().min(1),
    datasetId: z.string().min(1),
    datasetName: z.string().min(1),
    metric: resolvedInsightMetricSchema,
    documentId: z.string().min(1),
    documentName: z.string().min(1),
    citation: documentChatCitationSchema,
  })
  .strict();

export const resolvedSessionSynthesisSchema = z
  .object({
    findings: z.array(resolvedSessionFindingSchema),
  })
  .strict();

export type ResolvedSessionFindingShape = z.infer<typeof resolvedSessionFindingSchema>;
export type ResolvedSessionSynthesisShape = z.infer<typeof resolvedSessionSynthesisSchema>;

export const sessionSynthesisToolSchema = {
  type: "object" as const,
  properties: {
    findings: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          finding: { type: "string" as const },
          whyItMatters: { type: "string" as const },
          datasetId: { type: "string" as const },
          metric: insightMetricJsonSchema,
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
        required: ["finding", "whyItMatters", "datasetId", "metric", "documentId", "citation"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
};
