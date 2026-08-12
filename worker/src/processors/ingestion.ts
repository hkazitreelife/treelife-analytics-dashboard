import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  readIngestionLimits,
  type IngestionJobData,
  type NormalizedDatasetShape,
} from "@analytics/shared";
import type { Payload } from "payload";

import type { GeminiClient } from "../services/gemini";
import {
  mergeDataset,
  MergeError,
  type MergeResult,
} from "../services/mergeDataset";
import {
  EmptyFileError,
  LimitExceededError,
  parseSpreadsheet,
  resolveDeterministicType,
  UnsupportedFileTypeError,
  type ParsedFile,
} from "../services/spreadsheetParser";

/**
 * The ingestion pipeline. Order matters: deterministic parsing and limit checks
 * happen before any AI call, so an oversized or unsupported file never costs a
 * model request. Nothing is written to the Dataset until the merged result has
 * passed schema validation.
 */

export class IngestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestionError";
  }
}

// fileURLToPath, not URL.pathname: the latter leaves percent-encoding in place,
// which breaks any path containing a space.
const MEDIA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../apps/web/media",
);

export type IngestionDeps = {
  payload: Payload;
  gemini: GeminiClient;
  mediaDir?: string;
};

const loadFileBytes = async (
  mediaDir: string,
  filename: string,
): Promise<Buffer> => {
  try {
    return await readFile(path.join(mediaDir, filename));
  } catch (error: unknown) {
    throw new IngestionError(
      `Stored file "${filename}" could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

/**
 * Runs Gemini, then merge and validate. On validation failure the model is
 * retried exactly once with a stricter instruction naming the exact violation.
 */
const inferAndMerge = async (
  gemini: GeminiClient,
  parsed: ParsedFile,
  datasetId: string,
  sourceFile: NormalizedDatasetShape["sourceFile"],
  logger: Payload["logger"],
): Promise<MergeResult> => {
  const attempt = async (
    stricterInstruction?: string,
  ): Promise<MergeResult> => {
    const metadata = await gemini.inferMetadata(
      parsed,
      stricterInstruction ? { stricterInstruction } : undefined,
    );

    return mergeDataset({ datasetId, sourceFile, parsed, metadata });
  };

  try {
    return await attempt();
  } catch (firstError: unknown) {
    const violation =
      firstError instanceof Error ? firstError.message : String(firstError);

    logger.warn(
      `Metadata failed validation, retrying once with stricter instruction. Violation: ${violation}`,
    );

    const stricter = [
      `The exact schema violation was: ${violation}`,
      "Return one entry per table, using the exact tableName strings supplied in",
      "the input, verbatim. Return one entry for every column index from 0 to",
      "width-1. headerRowIndex must be a valid zero-indexed row position within",
      "that table's rows. Every field in the response schema is required.",
      "Return JSON only.",
    ].join(" ");

    // A second failure is final. The job fails loudly rather than storing
    // partially valid output.
    return await attempt(stricter);
  }
};

export const processIngestionJob = async (
  data: IngestionJobData,
  deps: IngestionDeps,
): Promise<void> => {
  const { payload, gemini } = deps;
  const mediaDir = deps.mediaDir ?? MEDIA_DIR;
  const limits = readIngestionLimits();

  await payload.update({
    collection: "jobs",
    id: data.jobId,
    data: { status: "processing" },
  });

  const jobRecord = await payload.findByID({
    collection: "jobs",
    id: data.jobId,
    depth: 0,
  });

  const fileRecord = await payload.findByID({
    collection: "files",
    id: data.fileId,
    depth: 0,
  });

  if (!fileRecord.filename || !fileRecord.mimeType) {
    throw new IngestionError(
      "File record is missing a filename or mime type. Re-upload the file.",
    );
  }

  // Refuses unsupported formats before reading or parsing anything.
  const fileType = resolveDeterministicType(fileRecord.mimeType);
  const bytes = await loadFileBytes(mediaDir, fileRecord.filename);

  await payload.update({
    collection: "jobs",
    id: data.jobId,
    data: { status: "validating" },
  });

  const parsed = parseSpreadsheet(
    bytes,
    fileRecord.mimeType,
    fileRecord.filename,
    limits,
  );

  await payload.update({
    collection: "jobs",
    id: data.jobId,
    data: { status: "generating_config" },
  });

  const datasetId =
    jobRecord.dataset === null || jobRecord.dataset === undefined
      ? data.datasetId
      : String(jobRecord.dataset);

  const { dataset: normalized, totalDataRows } = await inferAndMerge(
    gemini,
    parsed,
    datasetId,
    {
      name: fileRecord.filename,
      type: fileType,
      hash: data.fileHash,
    },
    payload.logger,
  );

  // Only now, after full validation, is stored data replaced.
  await payload.update({
    collection: "datasets",
    id: datasetId,
    data: {
      data: {
        tables: normalized.tables,
        relationships: normalized.relationships,
      },
      tableNames: normalized.tables.map((table) => ({
        tableName: table.tableName,
      })),
      totalRows: totalDataRows,
      currentFile: fileRecord.id,
      currentFileHash: data.fileHash,
      status: "ready",
    },
  });

  await payload.update({
    collection: "jobs",
    id: data.jobId,
    data: {
      status: "completed",
      completedAt: new Date().toISOString(),
      error: null,
    },
  });
};

export {
  EmptyFileError,
  LimitExceededError,
  MergeError,
  UnsupportedFileTypeError,
};
