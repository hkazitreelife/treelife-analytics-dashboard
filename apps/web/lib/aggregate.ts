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
    let str = value.trim();

    if (str.length === 0) {
      return null;
    }

    // Handle negative numbers in accounting parentheses format: (1,234.56) or ($1,234.56)
    let isNegative = false;
    if (/^\(.*\)$/.test(str)) {
      isNegative = true;
      str = str.slice(1, -1).trim();
    } else if (str.startsWith("-")) {
      isNegative = true;
      str = str.slice(1).trim();
    }

    // Strip currency symbols and whitespace
    str = str.replace(/[$€£¥₹\s]|USD|EUR|GBP|INR|CAD|AUD/gi, "");

    // European format check: contains comma as decimal with dot as thousand separator (e.g. 1.234,56 or 1234,56)
    if (/^\d{1,3}(\.\d{3})*,\d+$/.test(str) || (!str.includes(".") && str.includes(","))) {
      str = str.replace(/\./g, "").replace(/,/g, ".");
    } else {
      // Standard US format (1,234.56) -> remove commas
      str = str.replace(/,/g, "");
    }

    // Remove percentage sign if present
    const isPercentage = str.endsWith("%");
    if (isPercentage) {
      str = str.slice(0, -1).trim();
    }

    const parsed = Number.parseFloat(str);

    if (!Number.isFinite(parsed)) {
      return null;
    }

    return isNegative ? -parsed : parsed;
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

  // Section 10.5: distinct is implemented for kpi_card (computeKpi, which
  // never reaches this function for that aggregation -- it counts unique
  // raw values of a named field, not a numeric measure). This function
  // only ever sees already-numeric-coerced values grouped per category
  // bucket, which is the wrong shape for "how many distinct values" of a
  // possibly non-numeric field, so a chart widget cannot correctly express
  // distinct-count today. Falling back to count (bucket size) rather than
  // sum: a wrong-but-plausible row count is a smaller error than silently
  // summing values that were never meant to be added. The system
  // instruction steers Claude away from putting "distinct" on a chart
  // widget in the first place, since a chart already shows distinct
  // categories as its own bars/slices.
  if (aggregation === "distinct") {
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
export type WidgetFilterSpec = {
  column: string;
  op?: "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "contains" | "in";
  value: unknown;
};

export const applyWidgetFilters = (
  rows: DataRow[],
  filter?: WidgetFilterSpec | null,
  filters?: WidgetFilterSpec[] | null,
  title?: string,
  columns?: DataColumn[],
): DataRow[] => {
  const allFilters: WidgetFilterSpec[] = [];
  if (filter && typeof filter === "object" && filter.column) {
    allFilters.push(filter);
  }
  if (Array.isArray(filters)) {
    for (const f of filters) {
      if (f && typeof f === "object" && f.column) {
        allFilters.push(f);
      }
    }
  }

  if (allFilters.length === 0) {
    return rows;
  }

  return rows.filter((row) =>
    allFilters.every((f) => {
      const colKey = Object.keys(row).find(
        (k) => k.trim().toLowerCase() === f.column.trim().toLowerCase(),
      ) ?? f.column;
      const cellVal = row[colKey];
      if (cellVal === undefined || cellVal === null) {
        return false;
      }
      const op = f.op ?? "eq";
      const targetVal = f.value;

      if (op === "eq") {
        if (typeof targetVal === "number") {
          return toNumber(cellVal) === targetVal;
        }
        return String(cellVal).trim().toLowerCase() === String(targetVal).trim().toLowerCase();
      }
      if (op === "neq") {
        if (typeof targetVal === "number") {
          return toNumber(cellVal) !== targetVal;
        }
        return String(cellVal).trim().toLowerCase() !== String(targetVal).trim().toLowerCase();
      }
      if (op === "lt") {
        const num = toNumber(cellVal);
        const target = toNumber(targetVal);
        return num !== null && target !== null && num < target;
      }
      if (op === "lte") {
        const num = toNumber(cellVal);
        const target = toNumber(targetVal);
        return num !== null && target !== null && num <= target;
      }
      if (op === "gt") {
        const num = toNumber(cellVal);
        const target = toNumber(targetVal);
        return num !== null && target !== null && num > target;
      }
      if (op === "gte") {
        const num = toNumber(cellVal);
        const target = toNumber(targetVal);
        return num !== null && target !== null && num >= target;
      }
      if (op === "contains") {
        return String(cellVal).toLowerCase().includes(String(targetVal).toLowerCase());
      }
      if (op === "in") {
        if (Array.isArray(targetVal)) {
          const lowerArr = targetVal.map((v) => String(v).toLowerCase());
          return lowerArr.includes(String(cellVal).toLowerCase());
        }
        return false;
      }
      return true;
    }),
  );
};

/**
 * Groups rows by the category field and aggregates each measure within the
 * group.
 */
export const buildCategorySeries = (
  rows: DataRow[],
  categoryField: string,
  measureFields: string[],
  aggregation: AggregationTypeValue,
  columns: DataColumn[],
  filter?: WidgetFilterSpec | null,
  filters?: WidgetFilterSpec[] | null,
  title?: string,
): CategorySeries[] => {
  const groups = new Map<string, DataRow[]>();
  const aggregatableRows = excludeTotalRows(rows, columns);
  const targetRows = applyWidgetFilters(aggregatableRows, filter, filters, title, columns);

  for (const row of targetRows) {
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
      entry.value = bucket.length;
      if (categoryField && categoryField !== "category") {
        entry[categoryField] = bucket.length;
      }

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
  filter?: WidgetFilterSpec | null,
  filters?: WidgetFilterSpec[] | null,
  title?: string,
): KpiResult => {
  const { measureFields } = resolveChartFields(fields, columns);
  const aggregatableRows = excludeTotalRows(rows, columns);
  const targetRows = applyWidgetFilters(aggregatableRows, filter, filters, title, columns);

  if (aggregation === "distinct") {
    const field = fields[0];

    if (!field) {
      return { kind: "not-numeric", field: "" };
    }

    const distinctValues = new Set(
      targetRows
        .map((row) => row[field])
        .filter((value) => !isBlank(value))
        .map((value) => String(value)),
    );

    return {
      kind: "value",
      value: distinctValues.size,
      field,
      usedRows: targetRows.length,
    };
  }

  if (aggregation === "count") {
    return {
      kind: "value",
      value: targetRows.length,
      field: null,
      usedRows: targetRows.length,
    };
  }

  if (fields.length === 0) {
    return {
      kind: "value",
      value: targetRows.length,
      field: null,
      usedRows: targetRows.length,
    };
  }

  const field = measureFields[0] ?? null;

  if (!field) {
    return { kind: "not-numeric", field: fields[0]! };
  }

  const values = targetRows
    .map((row) => toNumber(row[field]))
    .filter((value): value is number => value !== null);

  return {
    kind: "value",
    value: applyAggregation(values, aggregation, targetRows.length),
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

export const resolveMetricValue = (
  metric: any,
  tables?: Record<string, { status: string; rows?: Record<string, unknown>[]; columns?: DataColumn[] }>,
): number | null => {
  if (!metric) return null;

  if (typeof metric.value === "number" && Number.isFinite(metric.value)) {
    return metric.value;
  }

  const parsed = toNumber(metric.value);
  if (parsed !== null) {
    return parsed;
  }

  if (tables) {
    const tableKeys = Object.keys(tables);
    const targetKey = metric.sourceTable
      ? tableKeys.find((k) => k.trim().toLowerCase() === String(metric.sourceTable).trim().toLowerCase())
      : (tableKeys.length === 1 ? tableKeys[0] : null);

    if (targetKey && tables[targetKey]) {
      const tableState = tables[targetKey];
      if (tableState && tableState.status === "ready" && tableState.rows && tableState.columns) {
        if (metric.kind === "row" && metric.labelColumn && metric.valueColumn) {
          const target = String(metric.labelValue ?? "").trim().toLowerCase();
          const match = tableState.rows.find((r: any) => {
            const lKey = Object.keys(r).find(
              (k) => k.trim().toLowerCase() === String(metric.labelColumn).trim().toLowerCase(),
            ) ?? metric.labelColumn;
            const cell = String(r[lKey] ?? "").trim().toLowerCase();
            return cell === target || cell.includes(target) || target.includes(cell);
          });
          if (match) {
            const vKey = Object.keys(match).find(
              (k) => k.trim().toLowerCase() === String(metric.valueColumn).trim().toLowerCase(),
            ) ?? metric.valueColumn;
            const val = toNumber(match[vKey]);
            if (val !== null) return val;
          }
        } else {
          const aggregatableRows = excludeTotalRows(tableState.rows, tableState.columns);
          const filtered = applyWidgetFilters(
            aggregatableRows,
            metric.filter,
            metric.filters,
            metric.label,
            tableState.columns,
          );

          if (metric.aggregation === "count" || !metric.sourceField) {
            return filtered.length;
          }

          const sKey = metric.sourceField
            ? (Object.keys(aggregatableRows[0] ?? {}).find(
                (k) => k.trim().toLowerCase() === String(metric.sourceField).trim().toLowerCase(),
              ) ?? metric.sourceField)
            : null;

          if (!sKey) {
            return filtered.length;
          }

          const vals = filtered
            .map((r: any) => toNumber(r[sKey]))
            .filter((v): v is number => v !== null);

          if (vals.length > 0) {
            if (metric.aggregation === "avg") {
              return vals.reduce((a, b) => a + b, 0) / vals.length;
            }
            if (metric.aggregation === "min") {
              return Math.min(...vals);
            }
            if (metric.aggregation === "max") {
              return Math.max(...vals);
            }
            return vals.reduce((a, b) => a + b, 0);
          }
          return filtered.length;
        }
      }
    }
  }

  return null;
};
