import { createHash } from "node:crypto";
import path from "node:path";

import type { IngestionLimits } from "@analytics/shared";
import * as XLSX from "xlsx";

/**
 * Deterministic extraction. This module reads bytes and produces raw rows. It
 * never calls an AI model, never samples away data, and makes no assumption
 * about which row holds the headers: Section 11.5 assigns header-row detection
 * to the inference step, and real files put titles and prose above the header.
 */

export type ParsedColumnSamples = {
  columnIndex: number;
  sampleValues: string[];
};

export type ParsedTable = {
  tableName: string;
  /** Widest row in the sheet, so no trailing column is lost. */
  width: number;
  /** Every non-blank row, verbatim and in order, headers included. */
  rawRows: unknown[][];
  /** Hash of the raw extraction, independent of any header decision. */
  rawRowHash: string;
  /** First rows, stringified, so the inference step can locate the header. */
  previewRows: string[][];
  /** Distinct sample values per column index, before names are known. */
  columnSamples: ParsedColumnSamples[];
};

export type ParsedFile = {
  tables: ParsedTable[];
  /** Raw row count across all tables, before header rows are removed. */
  totalRawRows: number;
};

export class LimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LimitExceededError";
  }
}

export class UnsupportedFileTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedFileTypeError";
  }
}

export class EmptyFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptyFileError";
  }
}

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const CSV_MIMES = new Set(["text/csv", "application/csv"]);

/** How many leading rows are shown to the inference step. */
export const PREVIEW_ROW_COUNT = 6;

export type DeterministicFileType = "xlsx" | "csv";

/**
 * Only xlsx and csv are handled in this phase. Anything else is refused rather
 * than guessed at.
 */
export const resolveDeterministicType = (
  mimeType: string,
): DeterministicFileType => {
  const normalized = mimeType.toLowerCase();

  if (normalized === XLSX_MIME) {
    return "xlsx";
  }

  if (CSV_MIMES.has(normalized)) {
    return "csv";
  }

  throw new UnsupportedFileTypeError(
    `File type "${mimeType}" is unsupported in this phase. Only xlsx and csv are parsed today.`,
  );
};

export const stringifyCell = (value: unknown): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return String(value);
};

export const isEmptyCell = (value: unknown): boolean =>
  value === null || value === undefined || value === "";

/**
 * Turns one raw row into column names. Empty or duplicated cells get stable
 * synthetic names so no column is silently merged away or dropped.
 */
export const deriveColumnNames = (
  headerRow: unknown[],
  width: number,
): string[] => {
  const names: string[] = [];
  const seen = new Map<string, number>();

  for (let index = 0; index < width; index += 1) {
    const raw = headerRow[index];
    let name = isEmptyCell(raw)
      ? `column_${index + 1}`
      : stringifyCell(raw).trim();

    if (name.length === 0) {
      name = `column_${index + 1}`;
    }

    const priorCount = seen.get(name);

    if (priorCount === undefined) {
      seen.set(name, 1);
    } else {
      seen.set(name, priorCount + 1);
      name = `${name}_${priorCount + 1}`;
    }

    names.push(name);
  }

  return names;
};

export const hashRows = (rows: unknown): string =>
  createHash("sha256").update(JSON.stringify(rows)).digest("hex");

const buildTable = (
  tableName: string,
  matrix: unknown[][],
  limits: IngestionLimits,
): ParsedTable => {
  const width = matrix.reduce((widest, row) => Math.max(widest, row.length), 0);

  if (matrix.length > limits.maxRowsPerTable) {
    throw new LimitExceededError(
      `Table "${tableName}" has ${matrix.length} rows, exceeding the limit of ${limits.maxRowsPerTable} rows per table (MAX_ROWS_PER_TABLE). Nothing was imported.`,
    );
  }

  // Normalized to full width so a short row cannot shift values leftwards.
  const rawRows: unknown[][] = matrix.map((row) => {
    const normalized: unknown[] = [];

    for (let index = 0; index < width; index += 1) {
      const cell = row[index];

      normalized.push(isEmptyCell(cell) ? null : cell);
    }

    return normalized;
  });

  const previewRows = rawRows
    .slice(0, PREVIEW_ROW_COUNT)
    .map((row) => row.map((cell) => (isEmptyCell(cell) ? "" : stringifyCell(cell))));

  const columnSamples: ParsedColumnSamples[] = [];

  for (let index = 0; index < width; index += 1) {
    const sampleValues: string[] = [];

    for (const row of rawRows) {
      const value = row[index];

      if (isEmptyCell(value)) {
        continue;
      }

      const text = stringifyCell(value);

      if (sampleValues.length < 5 && !sampleValues.includes(text)) {
        sampleValues.push(text);
      }
    }

    columnSamples.push({ columnIndex: index, sampleValues });
  }

  return {
    tableName,
    width,
    rawRows,
    rawRowHash: hashRows(rawRows),
    previewRows,
    columnSamples,
  };
};

export const parseSpreadsheet = (
  buffer: Buffer,
  mimeType: string,
  filename: string,
  limits: IngestionLimits,
): ParsedFile => {
  const fileType = resolveDeterministicType(mimeType);
  const maxBytes = limits.uploadMaxSizeMb * 1024 * 1024;

  if (buffer.byteLength > maxBytes) {
    throw new LimitExceededError(
      `File is ${(buffer.byteLength / (1024 * 1024)).toFixed(2)} MB, exceeding the limit of ${limits.uploadMaxSizeMb} MB (UPLOAD_MAX_SIZE_MB). Nothing was imported.`,
    );
  }

  if (buffer.byteLength === 0) {
    throw new EmptyFileError("File is empty.");
  }

  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetNames = workbook.SheetNames;

  if (sheetNames.length === 0) {
    throw new EmptyFileError("File contains no sheets.");
  }

  // A CSV always yields exactly one table.
  const effectiveSheets =
    fileType === "csv" ? sheetNames.slice(0, 1) : sheetNames;

  if (effectiveSheets.length > limits.maxTablesPerFile) {
    throw new LimitExceededError(
      `File contains ${effectiveSheets.length} tables, exceeding the limit of ${limits.maxTablesPerFile} tables per file (MAX_TABLES_PER_FILE). Nothing was imported.`,
    );
  }

  const tables: ParsedTable[] = [];
  let totalRawRows = 0;

  for (const sheetName of effectiveSheets) {
    const sheet = workbook.Sheets[sheetName];

    if (!sheet) {
      continue;
    }

    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: null,
      // Excludes only wholly empty spacer rows, never rows with any content.
      blankrows: false,
      raw: true,
    });

    const tableName =
      fileType === "csv"
        ? path.basename(filename, path.extname(filename))
        : sheetName;

    const table = buildTable(tableName, matrix, limits);

    totalRawRows += table.rawRows.length;

    if (totalRawRows > limits.maxTotalRows) {
      throw new LimitExceededError(
        `File contains more than ${limits.maxTotalRows} rows across all tables (MAX_TOTAL_ROWS). Nothing was imported.`,
      );
    }

    tables.push(table);
  }

  return { tables, totalRawRows };
};
