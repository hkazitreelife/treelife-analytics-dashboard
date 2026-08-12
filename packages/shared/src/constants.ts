/**
 * Ingestion limits from project_requirement.md Section 11.2. Defaults here,
 * overridable by environment variable. Exceeding a limit is a clear rejection,
 * never a partial import.
 */
export const DEFAULT_LIMITS = {
  uploadMaxSizeMb: 25,
  maxRowsPerTable: 10_000,
  maxTotalRows: 25_000,
  maxTablesPerFile: 25,
} as const;

export type IngestionLimits = {
  uploadMaxSizeMb: number;
  maxRowsPerTable: number;
  maxTotalRows: number;
  maxTablesPerFile: number;
};

const positiveInt = (raw: string | undefined, fallback: number): number => {
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const readIngestionLimits = (
  env: Record<string, string | undefined> = process.env,
): IngestionLimits => ({
  uploadMaxSizeMb: positiveInt(
    env.UPLOAD_MAX_SIZE_MB,
    DEFAULT_LIMITS.uploadMaxSizeMb,
  ),
  maxRowsPerTable: positiveInt(
    env.MAX_ROWS_PER_TABLE,
    DEFAULT_LIMITS.maxRowsPerTable,
  ),
  maxTotalRows: positiveInt(env.MAX_TOTAL_ROWS, DEFAULT_LIMITS.maxTotalRows),
  maxTablesPerFile: positiveInt(
    env.MAX_TABLES_PER_FILE,
    DEFAULT_LIMITS.maxTablesPerFile,
  ),
});
