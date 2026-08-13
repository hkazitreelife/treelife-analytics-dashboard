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
  "line",
  "pie",
  "table",
]);

export const aggregationTypeSchema = z.enum(["none", "sum", "count", "avg"]);

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

export const dashboardWidgetSchema = z
  .object({
    widgetId: z.string().min(1),
    type: widgetTypeSchema,
    title: z.string().min(1),
    sourceTable: z.string().min(1),
    fields: z.array(z.string().min(1)),
    aggregation: aggregationTypeSchema,
    position: widgetPositionSchema,
  })
  .strict();

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
  })
  .strict();

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
  value: z.number(),
});
export const resolvedInsightMetricSchema = z.discriminatedUnion("kind", [
  resolvedAggregateMetricSchema,
  resolvedRowMetricSchema,
]);

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

export const dashboardInsightSchema = z
  .object({
    insightId: z.string().min(1),
    finding: z.string().min(1),
    metrics: z.array(insightMetricRefSchema),
    whyItMatters: z.string().min(1),
    recommendedAction: z.string().min(1),
    severity: insightSeveritySchema,
    relatedTables: z.array(z.string().min(1)),
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
export type DashboardInsightShape = z.infer<typeof dashboardInsightSchema>;
export type ResolvedDashboardInsightShape = z.infer<typeof resolvedDashboardInsightSchema>;
export type DashboardConfigShape = z.infer<typeof dashboardConfigSchema>;
export type ResolvedDashboardConfigShape = z.infer<typeof resolvedDashboardConfigSchema>;

/** Recorded on every Configs row so a prompt edit is never mistaken for a first pass. */
export const CONFIG_SOURCE = {
  initialAutoGeneration: "initial_auto_generation",
  promptEdit: "prompt_edit",
} as const;

export type ConfigSource = (typeof CONFIG_SOURCE)[keyof typeof CONFIG_SOURCE];
