import type { DashboardConfigShape } from "./schemas/dashboardConfig";
import type { NormalizedTableShape } from "./schemas/normalizedDataset";

/**
 * Shared between the worker (initial config generation, worker/src/services/
 * claudeConfig.ts) and the web process (prompt-based editing,
 * apps/web/lib/claudeConfigEditClient.ts). Both build the same metadata shape
 * for Claude and validate its output against the same rules, so this lives
 * here once rather than drifting between two copies.
 */

/** Billing, quota or tier rejection. Never retried by either caller. */
export const isClaudeBillingRejection = (
  message: string,
  status?: number,
): boolean => {
  if (status === 402 || status === 429) {
    return true;
  }

  const text = message.toLowerCase();

  return [
    "credit balance",
    "billing",
    "insufficient",
    "quota",
    "rate limit",
    "rate_limit",
    "payment",
    "upgrade your plan",
  ].some((marker) => text.includes(marker));
};

export type NumericAggregate = {
  column: string;
  sum: number;
  avg: number;
  min: number;
  max: number;
  nonNullCount: number;
};

export type TableMetadataForClaude = {
  tableName: string;
  tableRole: string;
  rowCount: number;
  columns: {
    name: string;
    inferredType: string;
    nullable: boolean;
    sampleValues: string[];
    emptyCount: number;
  }[];
  numericAggregates: NumericAggregate[];
};

export type DatasetMetadataForClaude = {
  datasetId: string;
  datasetName: string;
  tables: TableMetadataForClaude[];
  relationships: unknown[];
  /**
   * Section 9.0's Overview rule: the one table initial config generation
   * must build every tab/widget from. Null when no data-role table exists
   * to identify one from (e.g. every table is documentation/config/
   * unknown). See identifyRawSheet for how this is chosen.
   */
  rawSheetTableName: string | null;
};

const asNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    // Tolerates currency symbols, thousands separators and stray spaces.
    const cleaned = value.replace(/[^0-9.eE+-]/g, "");
    const parsed = Number.parseFloat(cleaned);

    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

/**
 * A "TOTAL"/"Grand Total" row is a rollup of the other rows in its own
 * table, not a peer data point -- summing it alongside them double-counts
 * whatever it's a total of. Excluded from sum/avg/count aggregation only:
 * still a real row, still returned to and rendered by the plain table
 * widget, still visible everywhere except the aggregation math itself.
 *
 * Both this file's Claude-metadata aggregates and the browser's own live
 * aggregation (apps/web/lib/aggregate.ts) exclude it through this one
 * implementation, so the two can never disagree about which rows count.
 */
const TOTAL_ROW_LABELS = new Set(["total", "grand total"]);

export const isTotalRowLabel = (value: unknown): boolean =>
  typeof value === "string" && TOTAL_ROW_LABELS.has(value.trim().toLowerCase());

/**
 * The column identifying what each row represents, so a "TOTAL" row can
 * actually be recognized. Not a new Gemini field: deterministically the
 * first column whose inferredType suits a row label (categorical, date, or
 * id) -- the exact same rule apps/web/lib/aggregate.ts's resolveChartFields
 * already uses to pick a chart's category axis. A table with no such
 * column (e.g. all-numeric, or a pure id+numeric raw-data table) has no
 * label column and nothing gets excluded, which is correct: there is
 * nothing there to be labeled "TOTAL".
 */
export const findLabelColumnName = (
  columns: { name: string; inferredType: string }[],
): string | null => {
  const match = columns.find(
    (column) =>
      column.inferredType === "categorical" ||
      column.inferredType === "date" ||
      column.inferredType === "id",
  );

  return match?.name ?? null;
};

/** `rows` with its table's TOTAL/Grand Total row (if any) removed. */
export const excludeTotalRows = <T extends Record<string, unknown>>(
  rows: T[],
  columns: { name: string; inferredType: string }[],
): T[] => {
  const labelColumn = findLabelColumnName(columns);

  if (!labelColumn) {
    return rows;
  }

  return rows.filter((row) => !isTotalRowLabel(row[labelColumn]));
};

type RawSheetCandidate = {
  tableName: string;
  tableRole: string;
  rows: Record<string, unknown>[];
  columns: { name: string; inferredType: string }[];
};

/**
 * Section 9.0. Identifies the one "raw" sheet initial config generation
 * must build Overview from: the tableRole "data" table with the most rows,
 * excluding any data-role table that is itself a rollup/summary sheet (has
 * a TOTAL/Grand Total row) -- a sheet with its own rollup row is a derived
 * view of the real data, not the raw data itself, even where Gemini also
 * tagged it "data". Ties broken by original file order (first-listed
 * wins), never by name.
 *
 * Falls back to the highest-row-count data-role table even if it has a
 * TOTAL row, if every data-role table has one, so this only returns null
 * when there is truly no data-role table to pick from at all.
 */
export const identifyRawSheet = (
  tables: RawSheetCandidate[],
): string | null => {
  const dataRoleTables = tables.filter((table) => table.tableRole === "data");

  if (dataRoleTables.length === 0) {
    return null;
  }

  const withoutTotalRow = dataRoleTables.filter(
    (table) => excludeTotalRows(table.rows, table.columns).length === table.rows.length,
  );

  const pool = withoutTotalRow.length > 0 ? withoutTotalRow : dataRoleTables;

  let winner = pool[0]!;

  for (const table of pool.slice(1)) {
    if (table.rows.length > winner.rows.length) {
      winner = table;
    }
  }

  return winner.tableName;
};

/**
 * Section 9.0. At initial generation, every widget must source from the
 * identified raw sheet -- no other table gets an automatic tab. Insights
 * are exempt: an insight's relatedTables may still name any table, since
 * insights are not tabs and the business-figure/data-quality rules apply
 * dataset-wide. Schema validation cannot catch a widget quietly sourcing
 * from a different real table (it's a well-formed reference, just to the
 * wrong one), so this is checked the same way an invented name is.
 *
 * Not applied to prompt-edit or chat: pulling a previously-hidden table
 * into a new tab by prompt is the intended, only way to surface one, per
 * Section 9.0 item 4. This must never be called from that path.
 */
export const findExtraTabWidgets = (
  config: DashboardConfigShape,
  rawSheetTableName: string | null,
): string[] => {
  if (!rawSheetTableName) {
    return [];
  }

  const problems: string[] = [];

  for (const tab of config.tabs) {
    for (const widget of tab.widgets) {
      if (widget.sourceTable !== rawSheetTableName) {
        problems.push(
          `widget "${widget.widgetId}" in tab "${tab.tabName}" sources from "${widget.sourceTable}", not the identified raw sheet "${rawSheetTableName}"`,
        );
      }
    }
  }

  return problems;
};

/**
 * Builds the metadata payload sent to Claude, for either initial generation
 * or a prompt edit. Rows are read here to compute aggregates, and only the
 * aggregates leave this function. No row ever reaches the prompt.
 */
export const buildDatasetMetadata = (
  datasetId: string,
  datasetName: string,
  tables: NormalizedTableShape[],
  relationships: unknown[],
): DatasetMetadataForClaude => ({
  datasetId,
  datasetName,
  relationships,
  rawSheetTableName: identifyRawSheet(tables),
  tables: tables.map((table) => {
    const numericAggregates: NumericAggregate[] = [];
    // Excluded from the aggregates below only. rowCount and emptyCount
    // further down deliberately still read table.rows in full: a TOTAL row
    // is a real row that exists and has real (or blank) cells, it just
    // isn't a peer to sum alongside.
    const aggregatableRows = excludeTotalRows(table.rows, table.columns);

    for (const column of table.columns) {
      if (column.inferredType !== "numeric") {
        continue;
      }

      const values: number[] = [];

      for (const row of aggregatableRows) {
        const parsed = asNumber(row[column.name]);

        if (parsed !== null) {
          values.push(parsed);
        }
      }

      if (values.length === 0) {
        continue;
      }

      const sum = values.reduce((total, value) => total + value, 0);

      numericAggregates.push({
        column: column.name,
        sum: Number(sum.toFixed(6)),
        avg: Number((sum / values.length).toFixed(6)),
        min: Math.min(...values),
        max: Math.max(...values),
        nonNullCount: values.length,
      });
    }

    return {
      tableName: table.tableName,
      tableRole: table.tableRole,
      rowCount: table.rows.length,
      columns: table.columns.map((column) => ({
        name: column.name,
        inferredType: column.inferredType,
        nullable: column.nullable,
        sampleValues: column.sampleValues,
        emptyCount: table.rows.filter((row) => {
          const value = row[column.name];

          return value === null || value === undefined || value === "";
        }).length,
      })),
      numericAggregates,
    };
  }),
});

/**
 * Section 17.3/17.4. How much a table contributes to the chat agent's
 * bounded context: the same numeric aggregates every table gets (from
 * buildDatasetMetadata), plus full rows -- but only for tables at or under
 * this row count. Aggregates alone lose row-level facts a labeled total or a
 * specific record carries (e.g. a "Gap to commit" row sitting inside an
 * otherwise-numeric table); full rows preserve that, but only safely for a
 * table small enough that "all of it" is still a bounded, small payload.
 * Fixed, not env-configurable, same precedent as PREVIEW_ROW_COUNT in
 * worker/src/services/spreadsheetParser.ts: a deliberately narrow exception,
 * not something that scales with dataset size.
 */
export const CHAT_FULL_ROWS_TABLE_ROW_CEILING = 50;

export type ChatTableContext = TableMetadataForClaude & {
  /** Present only when this table's row count is at or under the ceiling. */
  rows?: Record<string, unknown>[];
};

export type ChatDatasetContext = {
  datasetId: string;
  datasetName: string;
  tables: ChatTableContext[];
  relationships: unknown[];
};

/**
 * Builds the chat agent's bounded context. Never full raw access to every
 * table: a table over CHAT_FULL_ROWS_TABLE_ROW_CEILING contributes only its
 * aggregates, exactly like the config-generation/edit metadata. The backend
 * performs this lookup; Claude is never given a tool to fetch more.
 */
export const buildChatContext = (
  datasetId: string,
  datasetName: string,
  tables: NormalizedTableShape[],
  relationships: unknown[],
): ChatDatasetContext => {
  const base = buildDatasetMetadata(datasetId, datasetName, tables, relationships);

  return {
    ...base,
    tables: base.tables.map((tableMeta, index) => {
      const table = tables[index]!;

      if (table.rows.length > CHAT_FULL_ROWS_TABLE_ROW_CEILING) {
        return tableMeta;
      }

      return { ...tableMeta, rows: table.rows };
    }),
  };
};

/**
 * Rejects a config that references a table or column which does not exist.
 * Schema validation cannot catch this, because an invented name is a
 * well-formed string. Returns the list of problems, empty when clean.
 */
export const findUnknownReferences = (
  config: DashboardConfigShape,
  tables: NormalizedTableShape[],
): string[] => {
  const columnsByTable = new Map(
    tables.map((table) => [
      table.tableName,
      new Set(table.columns.map((column) => column.name)),
    ]),
  );

  const problems: string[] = [];

  for (const tab of config.tabs) {
    for (const widget of tab.widgets) {
      const columns = columnsByTable.get(widget.sourceTable);

      if (!columns) {
        problems.push(
          `widget "${widget.widgetId}" references unknown table "${widget.sourceTable}"`,
        );
        continue;
      }

      for (const field of widget.fields) {
        if (!columns.has(field)) {
          problems.push(
            `widget "${widget.widgetId}" references unknown column "${field}" in table "${widget.sourceTable}"`,
          );
        }
      }
    }
  }

  for (const insight of config.insights) {
    for (const tableName of insight.relatedTables) {
      if (!columnsByTable.has(tableName)) {
        problems.push(
          `insight "${insight.insightId}" references unknown table "${tableName}"`,
        );
      }
    }
  }

  return problems;
};

/**
 * The emit_dashboard_config tool's input schema. Shared so the initial
 * generation call and the prompt-edit call force the exact same structural
 * shape at the API level — both produce a DashboardConfigShape, so there is
 * no reason for the two tool schemas to ever disagree.
 */
export const dashboardConfigToolSchema = {
  type: "object" as const,
  properties: {
    datasetId: { type: "string" },
    title: { type: "string" },
    tabs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tabId: { type: "string" },
          tabName: { type: "string" },
          widgets: {
            type: "array",
            items: {
              type: "object",
              properties: {
                widgetId: { type: "string" },
                type: {
                  type: "string",
                  enum: ["kpi_card", "bar", "line", "pie", "table"],
                },
                title: { type: "string" },
                sourceTable: { type: "string" },
                fields: { type: "array", items: { type: "string" } },
                aggregation: {
                  type: "string",
                  enum: ["none", "sum", "count", "avg"],
                },
                position: {
                  type: "object",
                  properties: {
                    row: { type: "integer" },
                    col: { type: "integer" },
                    w: { type: "integer" },
                    h: { type: "integer" },
                  },
                  required: ["row", "col", "w", "h"],
                  additionalProperties: false,
                },
              },
              required: [
                "widgetId",
                "type",
                "title",
                "sourceTable",
                "fields",
                "aggregation",
                "position",
              ],
              additionalProperties: false,
            },
          },
        },
        required: ["tabId", "tabName", "widgets"],
        additionalProperties: false,
      },
    },
    insights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          insightId: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          severity: {
            type: "string",
            enum: ["info", "warning", "positive", "negative"],
          },
          relatedTables: { type: "array", items: { type: "string" } },
        },
        required: [
          "insightId",
          "title",
          "body",
          "severity",
          "relatedTables",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["datasetId", "title", "tabs", "insights"],
  additionalProperties: false,
};
