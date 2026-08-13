import { z } from "zod";

import { sourceFileSchema } from "./normalizedDataset";

/**
 * Section 10.0. The second, parallel extraction contract for a PDF/PPTX/DOCX
 * whose content is prose rather than rows and columns -- a memo, a report, a
 * slide deck -- as opposed to Section 14's tables[]/relationships[] contract
 * for spreadsheet-shaped data. Deliberately not merged into or reusing
 * NormalizedDatasetShape: the two shapes describe fundamentally different
 * things (cells in a grid vs. text with structure), and forcing one type to
 * cover both would mean every existing table-path reader (the renderer, chat,
 * aggregate.ts, promptEdit.ts) would need to branch on which shape it got.
 * This lives in its own collection (Documents, apps/web/collections/
 * Documents.ts), parallel to Datasets, never inside it.
 */

export const documentSectionSchema = z
  .object({
    sectionId: z.string().min(1),
    heading: z.string().min(1),
    // Verbatim, Gemini's own structural breakdown (a slide, a heading's
    // paragraph, whatever the source format naturally has) -- no
    // interpretation at this stage. Can be empty for a heading-only slide.
    rawContent: z.string(),
  })
  .strict();

export const normalizedDocumentSchema = z
  .object({
    documentId: z.string().min(1),
    sourceFile: sourceFileSchema,
    // The complete extracted text, verbatim from Gemini. This is what the
    // "give me more" follow-up (Section 10.0 Step 4) reads from -- no
    // re-extraction, and it is also what every keyPoint's quote is checked
    // against (documentContract.ts's quoteExistsInText).
    fullText: z.string().min(1),
    sections: z.array(documentSectionSchema).min(1),
  })
  .strict();

export type DocumentSectionShape = z.infer<typeof documentSectionSchema>;
export type NormalizedDocumentShape = z.infer<typeof normalizedDocumentSchema>;

/**
 * Gemini's own output contract for a PDF/PPTX/DOCX extraction call --
 * documentKind is the one field Step 1 requires, decided once, during this
 * same call (no second model call spent purely on classification).
 *
 * When tabular, fullText/sections are absent: Section 14's existing table
 * pipeline has no code path today that turns an arbitrary PDF/PPTX/DOCX's
 * tables into its rawRows/columnSamples shape (that pipeline has only ever
 * consumed the deterministic xlsx/csv parser's output) -- building that
 * extraction is a materially different, larger problem this prompt does not
 * ask for, and Section 14 must not be touched. A tabular verdict here is
 * therefore a clear, explicit "not supported in this phase" failure
 * (worker/src/processors/documentIngestion.ts), mirroring
 * UnsupportedFileTypeError exactly, never a silent or partial routing into
 * Section 14's pipeline.
 */
export const geminiNarrativeExtractionSchema = z
  .object({
    documentKind: z.literal("narrative"),
    fullText: z.string().min(1),
    sections: z.array(documentSectionSchema).min(1),
  })
  .strict();

export const geminiTabularVerdictSchema = z
  .object({
    documentKind: z.literal("tabular"),
  })
  .strict();

export const geminiDocumentExtractionSchema = z.discriminatedUnion(
  "documentKind",
  [geminiNarrativeExtractionSchema, geminiTabularVerdictSchema],
);

export type GeminiDocumentExtractionShape = z.infer<
  typeof geminiDocumentExtractionSchema
>;
