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

export const dashboardInsightSchema = z
  .object({
    insightId: z.string().min(1),
    title: z.string().min(1),
    body: z.string().min(1),
    severity: insightSeveritySchema,
    relatedTables: z.array(z.string().min(1)),
  })
  .strict();

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

export type WidgetTypeValue = z.infer<typeof widgetTypeSchema>;
export type AggregationTypeValue = z.infer<typeof aggregationTypeSchema>;
export type InsightSeverityValue = z.infer<typeof insightSeveritySchema>;
export type DashboardWidgetShape = z.infer<typeof dashboardWidgetSchema>;
export type DashboardTabShape = z.infer<typeof dashboardTabSchema>;
export type DashboardInsightShape = z.infer<typeof dashboardInsightSchema>;
export type DashboardConfigShape = z.infer<typeof dashboardConfigSchema>;

/** Recorded on every Configs row so a prompt edit is never mistaken for a first pass. */
export const CONFIG_SOURCE = {
  initialAutoGeneration: "initial_auto_generation",
  promptEdit: "prompt_edit",
} as const;

export type ConfigSource = (typeof CONFIG_SOURCE)[keyof typeof CONFIG_SOURCE];
