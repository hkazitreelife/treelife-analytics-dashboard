import { z } from "zod";

/**
 * Section 10.2. The document-chat answer contract, structurally the
 * resolved-not-typed principle's equivalent for a narrative document: a
 * dataset chat answer cites a {sourceTable, sourceField, aggregation} the
 * server resolves to a number; a document has no rows to aggregate, so the
 * equivalent claim is a citation -- {sectionId, quote} -- the server
 * verifies is a real, verbatim excerpt of fullText (documentContract.ts's
 * findUnverifiableCitations, reusing quoteExistsInText), never trusted from
 * the model. Any specific figure or fact the answer depends on must be
 * backed by one of these, the same way a dataset answer's metrics back its
 * numbers.
 */

export const documentChatCitationSchema = z
  .object({
    sectionId: z.string().min(1),
    quote: z.string().min(1),
  })
  .strict();

export const documentChatAnswerSchema = z
  .object({
    directAnswer: z.string().min(1),
    citations: z.array(documentChatCitationSchema),
    caveats: z.string().optional(),
  })
  .strict();

export type DocumentChatCitationShape = z.infer<typeof documentChatCitationSchema>;
export type DocumentChatAnswerShape = z.infer<typeof documentChatAnswerSchema>;

export const documentChatAnswerToolSchema = {
  type: "object" as const,
  properties: {
    directAnswer: { type: "string" as const },
    citations: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          sectionId: { type: "string" as const },
          quote: { type: "string" as const },
        },
        required: ["sectionId", "quote"],
        additionalProperties: false,
      },
    },
    caveats: { type: "string" as const },
  },
  required: ["directAnswer", "citations"],
  additionalProperties: false,
};
