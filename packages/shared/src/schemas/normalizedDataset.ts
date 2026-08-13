import { z } from "zod";

/**
 * The normalized dataset contract from project_requirement.md Section 14.
 * This is the single boundary every extraction path must satisfy before its
 * output is allowed anywhere near storage. Model output is never trusted.
 */

export const supportedFileTypeSchema = z.enum([
  "xlsx",
  "csv",
  "pdf",
  "image",
  "pptx",
  "docx",
]);

export const inferredColumnTypeSchema = z.enum([
  "numeric",
  "categorical",
  "date",
  "id",
  "text",
  "boolean",
]);

export const tableRoleSchema = z.enum([
  "data",
  "documentation",
  "config",
  "unknown",
]);

const sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "Expected a lowercase hex sha256 digest.");

export const sourceFileSchema = z.object({
  name: z.string().min(1),
  type: supportedFileTypeSchema,
  hash: sha256Schema,
});

export const normalizedColumnSchema = z.object({
  name: z.string().min(1),
  inferredType: inferredColumnTypeSchema,
  nullable: z.boolean(),
  // Section 14: up to five raw sample values, used to sanity-check inference.
  sampleValues: z.array(z.string()).max(5),
});

export const normalizedTableSchema = z.object({
  tableName: z.string().min(1),
  tableRole: tableRoleSchema,
  /**
   * Zero-indexed position of the header row within the raw extracted rows.
   * Detected by the inference step, never assumed: real files place titles and
   * prose above the header.
   */
  headerRowIndex: z.number().int().min(0),
  columns: z.array(normalizedColumnSchema),
  rows: z.array(z.record(z.string(), z.unknown())),
  rowHash: sha256Schema,
});

export const normalizedRelationshipSchema = z.object({
  fromTable: z.string().min(1),
  fromColumn: z.string().min(1),
  toTable: z.string().min(1),
  toColumn: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export const normalizedDatasetSchema = z.object({
  datasetId: z.string().min(1),
  sourceFile: sourceFileSchema,
  tables: z.array(normalizedTableSchema),
  relationships: z.array(normalizedRelationshipSchema),
});

export type SupportedFileTypeValue = z.infer<typeof supportedFileTypeSchema>;
export type InferredColumnTypeValue = z.infer<typeof inferredColumnTypeSchema>;
export type TableRoleValue = z.infer<typeof tableRoleSchema>;
export type NormalizedColumnShape = z.infer<typeof normalizedColumnSchema>;
export type NormalizedTableShape = z.infer<typeof normalizedTableSchema>;
export type NormalizedRelationshipShape = z.infer<
  typeof normalizedRelationshipSchema
>;
export type NormalizedDatasetShape = z.infer<typeof normalizedDatasetSchema>;

/**
 * The metadata half of the contract: exactly what Gemini is allowed to decide.
 * Rows and row hashes are deliberately absent.
 */
export const geminiTableMetadataSchema = z.object({
  tableName: z.string().min(1),
  tableRole: tableRoleSchema,
  headerRowIndex: z.number().int().min(0),
  /**
   * Keyed by column index, not by name. Column names are only knowable once the
   * header row has been identified, so the inference step cannot key on them.
   */
  columns: z.array(
    z.object({
      columnIndex: z.number().int().min(0),
      inferredType: inferredColumnTypeSchema,
      nullable: z.boolean(),
    }),
  ),
});

export const geminiMetadataSchema = z.object({
  tables: z.array(geminiTableMetadataSchema),
  relationships: z.array(normalizedRelationshipSchema),
});

export type GeminiTableMetadata = z.infer<typeof geminiTableMetadataSchema>;
export type GeminiMetadata = z.infer<typeof geminiMetadataSchema>;
