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
 * Section 9.1. Claude names which real column and aggregation it is citing;
 * it never writes the number itself. `value` is deliberately absent here --
 * see resolveMetricReferences in claudeConfigContract.ts, which is the only
 * code allowed to produce one, computed from the dataset's real rows.
 */
export const insightMetricRefSchema = z
  .object({
    label: z.string().min(1),
    sourceTable: z.string().min(1),
    sourceField: z.string().min(1),
    aggregation: metricAggregationSchema,
  })
  .strict();

/** insightMetricRefSchema plus the server-computed value. Never model output. */
export const resolvedInsightMetricSchema = insightMetricRefSchema.extend({
  value: z.number(),
});

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
export type InsightMetricRefShape = z.infer<typeof insightMetricRefSchema>;
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
