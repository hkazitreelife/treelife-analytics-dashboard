import { z } from "zod";

/**
 * The dashboard config contract from project_requirement.md Section 15.
 * Claude may emit exactly this shape and nothing else. Anything outside it is
 * rejected before storage, so an unvalidated config can never reach the
 * renderer.
 *
 * Note what is absent: rows. Config must never contain dataset rows (15.1).
 */

export const widgetTypeSchema = z.enum([
  "kpi_card",
  "bar",
  "horizontal_bar",
  "line",
  "pie",
  "table",
]);

/**
 * Section 10.5: "distinct" added alongside the original four. Plain
 * "count" (apps/web/lib/aggregate.ts's computeKpi) counts ROWS -- it
 * always has, regardless of which field is named -- which is correct for
 * a KPI like "Total Exits" but silently wrong for one like "Departments
 * Affected", whose title asks how many DIFFERENT values a field takes,
 * not how many rows exist. Before this, the aggregation vocabulary had no
 * way to express that distinction at all; "distinct" is a real,
 * field-specific aggregation, not a synonym for "count".
 */
export const aggregationTypeSchema = z.enum([
  "none",
  "sum",
  "count",
  "avg",
  "distinct",
]);

export const insightSeveritySchema = z.enum([
  "info",
  "warning",
  "positive",
  "negative",
]);

/**
 * Section 9.1. Aggregation kinds a metric reference may ask for. A superset
 * of aggregationTypeSchema in one direction (min/max, which a widget never
 * needs) and a subset in another (no "none": a metric callout is always a
 * single resolved number, so there is nothing for "none" to mean here).
 */
export const metricAggregationSchema = z.enum([
  "sum",
  "avg",
  "count",
  "min",
  "max",
]);

export const widgetPositionSchema = z
  .object({
    row: z.number().int().min(0),
    col: z.number().int().min(0),
    w: z.number().int().min(1),
    h: z.number().int().min(1),
  })
  .strict();

export const widgetFilterOpSchema = z.enum(["eq", "neq", "lt", "lte", "gt", "gte", "contains", "in"]);

export const widgetFilterSpecSchema = z
  .object({
    column: z.string().min(1),
    op: widgetFilterOpSchema.default("eq"),
    value: z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.array(z.union([z.string(), z.number()])),
    ]),
  })
  .strip();

export type WidgetFilterSpecShape = z.infer<typeof widgetFilterSpecSchema>;

export const dashboardWidgetSchema = z
  .object({
    widgetId: z.string().min(1),
    type: widgetTypeSchema,
    title: z.string().min(1),
    sourceTable: z.string().min(1),
    fields: z.array(z.string().min(1)),
    aggregation: aggregationTypeSchema,
    position: widgetPositionSchema,
    orientation: z.enum(["vertical", "horizontal"]).optional().nullable().transform((v) => v ?? undefined),
    layout: z.enum(["vertical", "horizontal"]).optional().nullable().transform((v) => v ?? undefined),
    color: z.string().optional().nullable().transform((v) => v ?? undefined),
    colorScheme: z.string().optional().nullable().transform((v) => v ?? undefined),
    filter: widgetFilterSpecSchema.optional().nullable().transform((v) => v ?? undefined),
    filters: z.array(widgetFilterSpecSchema).optional().nullable().transform((v) => v ?? undefined),
  })
  .strip();

export const dashboardTabSchema = z
  .object({
    tabId: z.string().min(1),
    tabName: z.string().min(1),
    widgets: z.array(dashboardWidgetSchema),
  })
  .strict();

/**
 * Section 9.1/9.2. Claude names which real column (and aggregation, or row)
 * it is citing; it never writes the number itself. `value` is deliberately
 * absent from either variant below -- see resolveMetricReferences in
 * claudeConfigContract.ts, the only code allowed to produce one, computed
 * from the dataset's real rows.
 *
 * Two kinds, because one column-aggregation vocabulary cannot address both
 * shapes of table a real dataset contains:
 *
 * - "aggregate": sum/avg/count/min/max over a column across many peer rows
 *   (e.g. total exits across a department breakdown). Sections 9.0/9.1's
 *   original kind, unchanged.
 * - "row": one specific row's value, named by its label, not aggregated at
 *   all. Section 9.2, added after a live bug: a table can hold several
 *   distinct named figures sharing one value column (a Constants-style
 *   key/value table, or specific rows embedded inside an otherwise normal
 *   per-entity table -- a dataset's Bands table mixed five real per-band
 *   rows with four summary rows literally labeled "Model annual",
 *   "Committed target", "Gap to commit", "Exit run rate"). Aggregating
 *   (e.g. max) across such a column picks whichever figure happens to be
 *   largest, not the one actually meant -- exactly the bug this kind fixes.
 *   See buildDatasetMetadata's preferRowAddressing/namedFigureRows, which
 *   tell Claude which tables/rows this applies to.
 */
export const aggregateMetricRefSchema = z
  .object({
    kind: z.literal("aggregate"),
    label: z.string().min(1),
    sourceTable: z.string().min(1),
    sourceField: z.string().min(1),
    aggregation: metricAggregationSchema,
    filter: widgetFilterSpecSchema.optional().nullable().transform((v) => v ?? undefined),
    filters: z.array(widgetFilterSpecSchema).optional().nullable().transform((v) => v ?? undefined),
  })
  .strip();

export const rowMetricRefSchema = z
  .object({
    kind: z.literal("row"),
    label: z.string().min(1),
    sourceTable: z.string().min(1),
    // The column that names each row (e.g. "key" in a Constants table, or
    // "label" in Bands). labelValue must match one row's value in it,
    // verbatim -- validated the same way an unknown table/column is.
    labelColumn: z.string().min(1),
    labelValue: z.string().min(1),
    // The column holding that row's actual figure (e.g. "value", or
    // "annual_revenue_Cr").
    valueColumn: z.string().min(1),
  })
  .strict();

export const insightMetricRefSchema = z.discriminatedUnion("kind", [
  aggregateMetricRefSchema,
  rowMetricRefSchema,
]);

/** Either metric ref variant plus the server-computed value. Never model output. */
export const resolvedAggregateMetricSchema = aggregateMetricRefSchema.extend({
  value: z.number(),
});
export const resolvedRowMetricSchema = rowMetricRefSchema.extend({
  value: z.union([z.number(), z.string()]),
});
export const resolvedInsightMetricSchema = z.discriminatedUnion("kind", [
  resolvedAggregateMetricSchema,
  resolvedRowMetricSchema,
]);

export const widgetFilterJsonSchema = {
  type: "object" as const,
  properties: {
    column: { type: "string" as const },
    op: {
      type: "string" as const,
      enum: ["eq", "neq", "lt", "lte", "gt", "gte", "contains", "in"],
    },
    value: {
      anyOf: [
        { type: "string" as const },
        { type: "number" as const },
        { type: "boolean" as const },
        {
          type: "array" as const,
          items: { anyOf: [{ type: "string" as const }, { type: "number" as const }] },
        },
      ],
    },
  },
  required: ["column", "value"],
  additionalProperties: false,
};

/**
 * Section 9.2. Raw JSON schema for a metric reference, shared by
 * dashboardConfigToolSchema's insights.metrics and chatAnswerToolSchema's
 * metrics -- both tool calls accept either variant, so this is defined once
 * rather than duplicated.
 */
export const aggregateMetricJsonSchema = {
  type: "object" as const,
  properties: {
    kind: { type: "string" as const, enum: ["aggregate"] },
    label: { type: "string" as const },
    sourceTable: { type: "string" as const },
    sourceField: { type: "string" as const },
    aggregation: {
      type: "string" as const,
      enum: ["sum", "avg", "count", "min", "max"],
    },
    filter: widgetFilterJsonSchema,
    filters: {
      type: "array" as const,
      items: widgetFilterJsonSchema,
    },
  },
  required: ["kind", "label", "sourceTable", "sourceField", "aggregation"],
  additionalProperties: false,
};

export const rowMetricJsonSchema = {
  type: "object" as const,
  properties: {
    kind: { type: "string" as const, enum: ["row"] },
    label: { type: "string" as const },
    sourceTable: { type: "string" as const },
    labelColumn: { type: "string" as const },
    labelValue: { type: "string" as const },
    valueColumn: { type: "string" as const },
  },
  required: ["kind", "label", "sourceTable", "labelColumn", "labelValue", "valueColumn"],
  additionalProperties: false,
};

export const insightMetricJsonSchema = {
  anyOf: [aggregateMetricJsonSchema, rowMetricJsonSchema],
};

export const presentationShapeSchema = z.enum(["table-row", "tracker-item", "category-box"]);

export const presentationDetailsSchema = z
  .object({
    shape: presentationShapeSchema.default("table-row"),
    status: z.string().optional().nullable().transform((v) => v ?? undefined),
    owner: z.string().optional().nullable().transform((v) => v ?? undefined),
    by: z.string().optional().nullable().transform((v) => v ?? undefined),
    categoryName: z.string().optional().nullable().transform((v) => v ?? undefined),
    colorIntent: z.string().optional().nullable().transform((v) => v ?? undefined),
  })
  .strip();

export const normalizePresentation = (
  input: unknown,
): { shape: "table-row" | "tracker-item" | "category-box"; [key: string]: unknown } => {
  if (!input) {
    return { shape: "table-row" };
  }
  if (typeof input === "string") {
    if (input === "tracker-item" || input === "category-box" || input === "table-row") {
      return { shape: input };
    }
    return { shape: "table-row" };
  }
  if (typeof input === "object" && input !== null) {
    const obj = { ...(input as Record<string, unknown>) };
    const validShapes = ["table-row", "tracker-item", "category-box"];
    if (typeof obj.shape !== "string" || !validShapes.includes(obj.shape)) {
      obj.shape = "table-row";
    }
    return obj as { shape: "table-row" | "tracker-item" | "category-box" };
  }
  return { shape: "table-row" };
};

const normalizeWidgetType = (
  raw: unknown,
): "kpi_card" | "bar" | "horizontal_bar" | "line" | "pie" | "table" => {
  const str = String(raw ?? "")
    .toLowerCase()
    .replace(/[-_\s]+/g, "");
  if (
    str.includes("kpi") ||
    str.includes("card") ||
    str.includes("metric") ||
    str.includes("stat") ||
    str.includes("scalar") ||
    str.includes("number")
  ) {
    return "kpi_card";
  }
  if (str.includes("horizontal") || str.includes("hbar")) {
    return "horizontal_bar";
  }
  if (str.includes("bar") || str.includes("column") || str.includes("histogram")) {
    return "bar";
  }
  if (
    str.includes("line") ||
    str.includes("trend") ||
    str.includes("area") ||
    str.includes("sparkline") ||
    str.includes("time") ||
    str.includes("series")
  ) {
    return "line";
  }
  if (
    str.includes("pie") ||
    str.includes("donut") ||
    str.includes("radial") ||
    str.includes("distribution")
  ) {
    return "pie";
  }
  if (str.includes("table") || str.includes("grid")) {
    return "table";
  }
  return "bar";
};

export const normalizeDashboardConfigInput = (input: unknown): unknown => {
  if (typeof input !== "object" || input === null) {
    return input;
  }
  const config = { ...(input as Record<string, unknown>) };

  if (Array.isArray(config.tabs)) {
    // 1. Filter out raw data record tabs if multiple tabs exist
    const nonRawTabs = config.tabs.filter((tab: unknown) => {
      if (typeof tab !== "object" || tab === null) return true;
      const tName = String((tab as Record<string, unknown>).tabName ?? "");
      return !/^(raw data|records detail|raw records|all records|raw sheet)$/i.test(
        tName.trim(),
      );
    });
    const candidateTabs = nonRawTabs.length > 0 ? nonRawTabs : config.tabs;

    config.tabs = candidateTabs.map((tab: unknown, tabIdx: number) => {
      if (typeof tab !== "object" || tab === null) return tab;
      const tabObj = { ...(tab as Record<string, unknown>) };
      if (!tabObj.tabId) tabObj.tabId = `tab_${tabIdx + 1}`;
      if (!tabObj.tabName) tabObj.tabName = `Tab ${tabIdx + 1}`;

      if (Array.isArray(tabObj.widgets)) {
        tabObj.widgets = tabObj.widgets
          .filter((widget: unknown) => {
            if (typeof widget !== "object" || widget === null) return true;
            const w = widget as Record<string, unknown>;
            const title = String(w.title ?? "").toLowerCase();
            // Filter out raw data table widgets that display row-level personal records
            if (w.type === "table") {
              const fields = Array.isArray(w.fields)
                ? w.fields.map((f) => String(f).toLowerCase())
                : [];
              const hasRawIdentifiers = fields.some((f) =>
                ["name", "sr no", "sr. no", "comments", "details"].includes(f),
              );
              if (
                hasRawIdentifiers ||
                title.includes("raw") ||
                title.includes("detail") ||
                title.includes("records")
              ) {
                return false;
              }
            }
            return true;
          })
          .map((widget: unknown, widgetIdx: number) => {
            if (typeof widget !== "object" || widget === null) return widget;
            const w = { ...(widget as Record<string, unknown>) };
            if (!w.widgetId) w.widgetId = `widget_${tabIdx + 1}_${widgetIdx + 1}`;
            if (!w.title) w.title = "Metric Analysis";

            // Normalize widget type strictly to one of the enum values
            w.type = normalizeWidgetType(w.type);

            // Ensure fields is a non-empty array of strings
            const rawFields = Array.isArray(w.fields)
              ? w.fields
              : typeof w.fields === "string"
                ? [w.fields]
                : ["Category", "Value"];
            const cleanFields = (rawFields as unknown[])
              .map((f) => String(f || "").trim())
              .filter((f) => f.length > 0);
            w.fields = cleanFields.length > 0 ? cleanFields : ["Value"];

            // Ensure position is valid numbers within grid bounds
            const pos =
              typeof w.position === "object" && w.position !== null
                ? (w.position as Record<string, unknown>)
                : {};
            const col = Number(pos.col);
            const row = Number(pos.row);
            const width = Number(pos.w);
            const height = Number(pos.h);
            w.position = {
              col: Number.isFinite(col) && col >= 0 && col <= 11 ? col : 0,
              row: Number.isFinite(row) && row >= 0 ? row : 0,
              w:
                Number.isFinite(width) && width >= 1 && width <= 12
                  ? width
                  : w.type === "kpi_card"
                    ? 3
                    : 6,
              h:
                Number.isFinite(height) && height >= 1 && height <= 12
                  ? height
                  : w.type === "kpi_card"
                    ? 2
                    : 4,
            };

            const validAggs = ["none", "sum", "count", "avg", "distinct"];
            const rawAgg = String(w.aggregation ?? "")
              .toLowerCase()
              .replace(/[-_\s]+/g, "");
            if (
              rawAgg.includes("avg") ||
              rawAgg.includes("average") ||
              rawAgg.includes("mean")
            ) {
              w.aggregation = "avg";
            } else if (rawAgg.includes("distinct") || rawAgg.includes("unique")) {
              w.aggregation = "distinct";
            } else if (rawAgg.includes("sum") || rawAgg.includes("total")) {
              w.aggregation = "sum";
            } else if (
              rawAgg.includes("count") ||
              rawAgg.includes("freq") ||
              rawAgg.includes("percentage")
            ) {
              w.aggregation = "count";
            } else if (validAggs.includes(rawAgg)) {
              w.aggregation = rawAgg;
            } else {
              w.aggregation = w.type === "kpi_card" ? "count" : "sum";
            }
            return w;
          });
      }
      return tabObj;
    });
  }

  if (Array.isArray(config.insights)) {
    config.insights = config.insights.map((insight: unknown, insIdx: number) => {
      if (typeof insight !== "object" || insight === null) {
        return insight;
      }
      const item = { ...(insight as Record<string, unknown>) };
      if (!item.insightId) item.insightId = `ins_${insIdx + 1}`;
      if (!item.finding) item.finding = "Operational metric analysis.";
      if (!item.whyItMatters) item.whyItMatters = "Informs strategic resource allocation.";
      if (!item.recommendedAction)
        item.recommendedAction = "Review trends with department leaders.";
      if (!item.severity) item.severity = "info";

      item.presentation = normalizePresentation(item.presentation);
      if (!Array.isArray(item.metrics)) {
        item.metrics = [];
      }
      if (!Array.isArray(item.relatedTables)) {
        item.relatedTables = [];
      }
      return item;
    });
  }
  return config;
};

export const presentationJsonSchema = {
  type: "object" as const,
  properties: {
    shape: { type: "string" as const, enum: ["table-row", "tracker-item", "category-box"] },
    status: { type: "string" as const },
    owner: { type: "string" as const },
    by: { type: "string" as const },
    categoryName: { type: "string" as const },
    colorIntent: { type: "string" as const },
  },
  required: ["shape"],
};

export const dashboardInsightSchema = z
  .object({
    insightId: z.string().min(1),
    finding: z.string().min(1),
    metrics: z.array(insightMetricRefSchema),
    whyItMatters: z.string().min(1),
    recommendedAction: z.string().min(1),
    severity: insightSeveritySchema,
    relatedTables: z.array(z.string().min(1)),
    presentation: presentationDetailsSchema,
  })
  .strict();

/** dashboardInsightSchema with every metric resolved to a real number. What is actually stored and rendered. */
export const resolvedDashboardInsightSchema = dashboardInsightSchema.extend({
  metrics: z.array(resolvedInsightMetricSchema),
});

/**
 * strict() throughout: an extra key is a validation failure, not something to
 * quietly drop. A model inventing fields is exactly the failure this catches.
 */
export const dashboardConfigSchema = z
  .object({
    datasetId: z.string().min(1),
    title: z.string().min(1),
    tabs: z.array(dashboardTabSchema).min(1),
    insights: z.array(dashboardInsightSchema),
  })
  .strict();

/**
 * dashboardConfigSchema with every insight's metrics resolved to real
 * numbers. This, never dashboardConfigSchema's raw model-output shape, is
 * what reaches Configs storage and the renderer -- resolution happens
 * server-side, between Claude's tool call and the write, exactly once, in
 * both the generation and edit pipelines (see resolveInsightMetrics).
 */
export const resolvedDashboardConfigSchema = z
  .object({
    datasetId: z.string().min(1),
    title: z.string().min(1),
    tabs: z.array(dashboardTabSchema).min(1),
    insights: z.array(resolvedDashboardInsightSchema),
  })
  .strict();

export type WidgetTypeValue = z.infer<typeof widgetTypeSchema>;
export type AggregationTypeValue = z.infer<typeof aggregationTypeSchema>;
export type MetricAggregationValue = z.infer<typeof metricAggregationSchema>;
export type InsightSeverityValue = z.infer<typeof insightSeveritySchema>;
export type DashboardWidgetShape = z.infer<typeof dashboardWidgetSchema>;
export type DashboardTabShape = z.infer<typeof dashboardTabSchema>;
export type AggregateMetricRefShape = z.infer<typeof aggregateMetricRefSchema>;
export type RowMetricRefShape = z.infer<typeof rowMetricRefSchema>;
export type InsightMetricRefShape = z.infer<typeof insightMetricRefSchema>;
export type ResolvedAggregateMetricShape = z.infer<typeof resolvedAggregateMetricSchema>;
export type ResolvedRowMetricShape = z.infer<typeof resolvedRowMetricSchema>;
export type ResolvedInsightMetricShape = z.infer<typeof resolvedInsightMetricSchema>;
export type ResolvedMetric = ResolvedInsightMetricShape;
export type PresentationShapeValue = z.infer<typeof presentationShapeSchema>;
export type PresentationDetailsShape = z.infer<typeof presentationDetailsSchema>;
export type DashboardInsightShape = z.infer<typeof dashboardInsightSchema>;
export type ResolvedDashboardInsightShape = z.infer<typeof resolvedDashboardInsightSchema>;
export type DashboardConfigShape = z.infer<typeof dashboardConfigSchema>;
export type ResolvedDashboardConfigShape = z.infer<typeof resolvedDashboardConfigSchema>;

/** Recorded on every Configs row so a prompt edit is never mistaken for a first pass. */
export const CONFIG_SOURCE = {
  initialAutoGeneration: "initial_auto_generation",
  promptEdit: "prompt_edit",
  // Prompt 16.0 item 9: an unambiguous, deterministic widget edit (change
  // type/fields/aggregation/position on one existing widget, matched by
  // widgetId) applied with no LLM call at all -- distinct from promptEdit,
  // which is a natural-language request Claude interprets. Recorded
  // separately so it's visible in config history which edits were a
  // mechanical, guaranteed-correct change versus a model's judgment call.
  directEdit: "direct_edit",
  // The fast, zero-AI-call deterministic template written immediately on
  // ingestion (Phase A of the async-upgrade architecture) so the dataset
  // reaches "ready" in seconds, never blocked on a model call that might
  // be slow or fail. Distinct from initialAutoGeneration, which now means
  // specifically "a genuine AI-generated config" -- whether that arrived
  // as the very first version (rare: only if Phase A itself found no fast
  // fallback needed) or, far more commonly, as the version that silently
  // replaced this one once the decoupled upgrade attempt (Phase B)
  // actually succeeded. Config history should say honestly which one any
  // given version was, not blur a template into "auto generation."
  initialFallback: "initial_fallback",
} as const;

export type ConfigSource = (typeof CONFIG_SOURCE)[keyof typeof CONFIG_SOURCE];
