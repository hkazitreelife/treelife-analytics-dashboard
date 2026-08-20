import { z } from "zod";
import { presentationDetailsSchema, presentationJsonSchema } from "./dashboardConfig";

/**
 * Section 10.0 Step 3. Claude's prioritized-summary contract for a narrative
 * document. Distinct from the dashboard-insight contract (dashboardConfig.ts):
 * a keyPoint's importance is a defined, accountable classification (see the
 * system instruction in worker/src/services/claudeDocumentSummary.ts for the
 * exact critical/high/medium definitions), and `quote` exists specifically so
 * a keyPoint can be checked against the source text in code, not trusted from
 * the model -- see documentContract.ts's quoteExistsInText, the only code
 * allowed to decide a quote is real.
 */

export const keyPointImportanceSchema = z.enum(["critical", "high", "medium"]);

export const keyPointSchema = z
  .object({
    pointId: z.string().min(1),
    statement: z.string().min(1),
    importance: keyPointImportanceSchema,
    supportingSectionIds: z.array(z.string().min(1)),
    // A short, verbatim excerpt from the document's fullText. Checked at the
    // write site (documentContract.ts's findUnverifiableQuotes) to actually
    // be a substring, case-insensitive and whitespace-tolerant -- never
    // merely "plausible."
    quote: z.string().min(1),
    presentation: presentationDetailsSchema,
  })
  .strict();

export const documentSummarySchema = z
  .object({
    keyPoints: z.array(keyPointSchema),
  })
  .strict();

export type KeyPointImportanceValue = z.infer<typeof keyPointImportanceSchema>;
export type KeyPointShape = z.infer<typeof keyPointSchema>;
export type DocumentSummaryShape = z.infer<typeof documentSummarySchema>;

/**
 * The emit_document_summary tool's input schema (initial summary) and the
 * emit_additional_key_points tool's input schema (Step 4's expand endpoint)
 * both emit this exact shape, so they share one JSON schema fragment.
 */
export const keyPointJsonSchema = {
  type: "object" as const,
  properties: {
    pointId: { type: "string" as const },
    statement: { type: "string" as const },
    importance: {
      type: "string" as const,
      enum: ["critical", "high", "medium"],
    },
    supportingSectionIds: {
      type: "array" as const,
      items: { type: "string" as const },
    },
    quote: { type: "string" as const },
    presentation: presentationJsonSchema,
  },
  required: ["pointId", "statement", "importance", "supportingSectionIds", "quote", "presentation"],
  additionalProperties: false,
};

export const documentSummaryToolSchema = {
  type: "object" as const,
  properties: {
    keyPoints: {
      type: "array" as const,
      items: keyPointJsonSchema,
    },
  },
  required: ["keyPoints"],
  additionalProperties: false,
};
