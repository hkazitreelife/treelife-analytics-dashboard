import { excludeTotalRows, type AggregationTypeValue } from "@analytics/shared";

/**
 * Client-side aggregation for the renderer. Pure functions, no knowledge of any
 * particular dataset: everything is driven by the field names the config names
 * and the column types the data endpoint reports.
 */

export type DataColumn = { name: string; inferredType: string };
export type DataRow = Record<string, unknown>;

export const toNumber = (value: unknown): number | null => {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    // Tolerates currency symbols, thousands separators and stray spaces.
    const cleaned = value.replace(/[^0-9.eE+-]/g, "");

    if (cleaned.length === 0) {
      return null;
    }

    const parsed = Number.parseFloat(cleaned);

    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

export const isBlank = (value: unknown): boolean =>
  value === null || value === undefined || value === "";

const applyAggregation = (
  values: number[],
  aggregation: AggregationTypeValue,
  rowCount: number,
): number => {
  if (aggregation === "count") {
    return rowCount;
  }

  if (values.length === 0) {
    return 0;
  }

  const sum = values.reduce((total, value) => total + value, 0);

  if (aggregation === "avg") {
    return sum / values.length;
  }

  // "none" on a single-value widget behaves as a sum of what was found.
  return sum;
};

/**
 * Picks which of a widget's fields is the category (x axis) and which is the
 * measure (y axis), using the reported column types rather than field order.
 */
export const resolveChartFields = (
  fields: string[],
  columns: DataColumn[],
): { categoryField: string | null; measureFields: string[] } => {
  const typeByName = new Map(columns.map((c) => [c.name, c.inferredType]));
  const present = fields.filter((field) => typeByName.has(field));

  const measureFields = present.filter(
    (field) => typeByName.get(field) === "numeric",
  );

  const categoryField =
    present.find((field) => {
      const type = typeByName.get(field);

      return type === "categorical" || type === "date" || type === "id";
    }) ??
    present.find((field) => !measureFields.includes(field)) ??
    null;

  return { categoryField, measureFields };
};

export type CategorySeries = { category: string; [measure: string]: unknown };

/**
 * Groups rows by the category field and aggregates each measure within the
 * group. Rows with a blank category are excluded rather than bucketed under an
 * empty label, which would read as a real category. A row whose table-level
 * label column reads "TOTAL"/"Grand Total" is also excluded here, before
 * grouping: otherwise it forms its own bucket and shows up as an extra bar,
 * pie slice, or line point that's actually a rollup of the other buckets,
 * not a peer to them.
 */
export const buildCategorySeries = (
  rows: DataRow[],
  categoryField: string,
  measureFields: string[],
  aggregation: AggregationTypeValue,
  columns: DataColumn[],
): CategorySeries[] => {
  const groups = new Map<string, DataRow[]>();
  const aggregatableRows = excludeTotalRows(rows, columns);

  for (const row of aggregatableRows) {
    const raw = row[categoryField];

    if (isBlank(raw)) {
      continue;
    }

    const key = String(raw);
    const bucket = groups.get(key);

    if (bucket) {
      bucket.push(row);
    } else {
      groups.set(key, [row]);
    }
  }

  return Array.from(groups.entries()).map(([category, bucket]) => {
    const entry: CategorySeries = { category };

    if (measureFields.length === 0) {
      entry.count = bucket.length;

      return entry;
    }

    for (const measure of measureFields) {
      const values = bucket
        .map((row) => toNumber(row[measure]))
        .filter((value): value is number => value !== null);

      entry[measure] = Number(
        applyAggregation(values, aggregation, bucket.length).toFixed(6),
      );
    }

    return entry;
  });
};

/**
 * Result of a kpi_card computation. "not-numeric" is a distinct, explicit
 * state rather than a number: sum/avg must refuse to run on a field whose
 * inferredType is not numeric, regardless of what the config asked for, and
 * the caller must render that refusal visibly rather than a fabricated value
 * or a silent blank.
 */
export type KpiResult =
  | { kind: "value"; value: number; field: string | null; usedRows: number }
  | { kind: "not-numeric"; field: string };

/** Single scalar for a kpi_card. */
export const computeKpi = (
  rows: DataRow[],
  fields: string[],
  columns: DataColumn[],
  aggregation: AggregationTypeValue,
): KpiResult => {
  const { measureFields } = resolveChartFields(fields, columns);
  // A "TOTAL"/"Grand Total" row is a rollup of the other rows in this same
  // table -- summing (or counting) it alongside them double-counts. Applies
  // to count too: "how many records" shouldn't count the rollup row as one
  // more record.
  const aggregatableRows = excludeTotalRows(rows, columns);

  if (aggregation === "count") {
    return {
      kind: "value",
      value: aggregatableRows.length,
      field: null,
      usedRows: aggregatableRows.length,
    };
  }

  if (fields.length === 0) {
    return {
      kind: "value",
      value: aggregatableRows.length,
      field: null,
      usedRows: aggregatableRows.length,
    };
  }

  const field = measureFields[0] ?? null;

  // sum/avg/none on a field that isn't numeric would otherwise fall through to
  // toNumber, which strips non-digit characters from strings such as ids and
  // returns a fabricated number. Refuse instead of guessing.
  if (!field) {
    return { kind: "not-numeric", field: fields[0]! };
  }

  const values = aggregatableRows
    .map((row) => toNumber(row[field]))
    .filter((value): value is number => value !== null);

  return {
    kind: "value",
    value: applyAggregation(values, aggregation, aggregatableRows.length),
    field,
    usedRows: values.length,
  };
};

export const formatNumber = (value: number): string => {
  if (!Number.isFinite(value)) {
    return "n/a";
  }

  if (Number.isInteger(value)) {
    return value.toLocaleString("en-IN");
  }

  return Number(value.toFixed(4)).toLocaleString("en-IN", {
    maximumFractionDigits: 4,
  });
};

export const formatCell = (value: unknown): string => {
  if (isBlank(value)) {
    return "";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    return formatNumber(value);
  }

  return String(value);
};
