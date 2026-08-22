import {
  CONFIG_SOURCE,
  dashboardConfigSchema,
  dashboardWidgetSchema,
  findHighCardinalityChartAxes,
  findUnresolvableMetrics,
  resolveInsightMetrics,
  resolvedDashboardConfigSchema,
  type DatasetEventType,
  type NormalizedTableShape,
  type ResolvedDashboardConfigShape,
} from "@analytics/shared";
import type { Payload } from "payload";

/**
 * Prompt 16.0 item 9: a fast, fully deterministic edit path for
 * unambiguous mechanical requests -- change one existing widget's type,
 * fields, aggregation, or position, matched exactly by widgetId. No LLM
 * call, no interpretation, no latency beyond a database round trip, no
 * failure mode beyond "that isn't a real column" or "that would chart a
 * near-unique column" -- the same two things a person editing a form
 * field would need told to them, not a technical schema-validation error
 * surfaced from a model's raw JSON output.
 *
 * Deliberately narrow: this can only change fields that already exist on
 * an already-real widget, to values that already exist on that widget's
 * already-real sourceTable. It cannot add a widget, remove a widget,
 * change sourceTable, reshape an insight, or do anything requiring
 * judgment about what the admin actually meant -- promptEdit.ts (the LLM
 * path) stays the only route for those, exactly as before. The rule for
 * which request goes to which path is structural, not a guess: if the
 * request names an existing widgetId and only the four fields below, it
 * is mechanical by definition and belongs here; anything else (a new
 * widget, a natural-language description, "make it better") has no
 * widgetId to anchor to and must go through the LLM path instead.
 *
 * Validation discipline matches every other write path in this codebase
 * exactly (findHighCardinalityChartAxes, findUnresolvableMetrics,
 * resolveInsightMetrics, both raw and resolved schema checks before
 * storage) -- a fast path is not a license to skip the checks that exist
 * everywhere else a config can be written; that would just be a second,
 * quieter way for bad output to reach storage.
 */

export type DirectWidgetEditInput = {
  type?: string;
  fields?: string[];
  aggregation?: string;
  position?: { row: number; col: number; w: number; h: number };
};

export type DirectWidgetEditDeps = {
  payload: Payload;
  publishEvent: (
    event: DatasetEventType,
    datasetId: string,
    jobId: string | null,
  ) => Promise<void>;
};

export type DirectWidgetEditResult =
  | { ok: true; datasetId: string; configVersion: number }
  | { ok: false; status: number; error: string };

type StoredDatasetData = { tables?: NormalizedTableShape[]; relationships?: unknown[] };

export const runDirectWidgetEdit = async (
  datasetId: string,
  widgetId: string,
  edit: DirectWidgetEditInput,
  deps: DirectWidgetEditDeps,
): Promise<DirectWidgetEditResult> => {
  const { payload, publishEvent } = deps;

  if (
    edit.type === undefined &&
    edit.fields === undefined &&
    edit.aggregation === undefined &&
    edit.position === undefined
  ) {
    return { ok: false, status: 400, error: "Nothing to change: provide at least one of type, fields, aggregation, position." };
  }

  let dataset;

  try {
    dataset = await payload.findByID({ collection: "datasets", id: datasetId, depth: 0 });
  } catch {
    return { ok: false, status: 404, error: "Dataset not found." };
  }

  const stored = dataset.data as StoredDatasetData | null;
  const tables = stored?.tables ?? [];

  if (tables.length === 0) {
    return { ok: false, status: 409, error: "This dataset has no stored data yet. Nothing to edit." };
  }

  const latestConfigs = await payload.find({
    collection: "configs",
    where: { dataset: { equals: Number(datasetId) } },
    limit: 1,
    depth: 0,
    sort: "-version,-createdAt",
  });

  const currentConfigRecord = latestConfigs.docs[0];

  if (!currentConfigRecord) {
    return { ok: false, status: 404, error: "No dashboard config exists for this dataset yet. Nothing to edit." };
  }

  const currentConfig = currentConfigRecord.config as ResolvedDashboardConfigShape;

  let foundTabIndex = -1;
  let foundWidgetIndex = -1;

  for (let t = 0; t < currentConfig.tabs.length; t++) {
    const idx = currentConfig.tabs[t]!.widgets.findIndex((w) => w.widgetId === widgetId);
    if (idx !== -1) {
      foundTabIndex = t;
      foundWidgetIndex = idx;
      break;
    }
  }

  if (foundTabIndex === -1) {
    return { ok: false, status: 404, error: `No widget with id "${widgetId}" exists in this dataset's current config.` };
  }

  const existingWidget = currentConfig.tabs[foundTabIndex]!.widgets[foundWidgetIndex]!;

  const columnsByTable = new Map(tables.map((t) => [t.tableName, new Set(t.columns.map((c) => c.name))]));
  const realColumns = columnsByTable.get(existingWidget.sourceTable);

  if (!realColumns) {
    // The widget's own sourceTable no longer exists on this dataset --
    // should not happen for a widget read straight out of the current
    // config, but if it does, this is not a mechanical edit anymore.
    return { ok: false, status: 409, error: `Widget "${widgetId}" references table "${existingWidget.sourceTable}", which no longer exists on this dataset.` };
  }

  if (edit.fields) {
    if (edit.fields.length === 0) {
      return { ok: false, status: 400, error: "fields must not be empty." };
    }
    const unknown = edit.fields.filter((f) => !realColumns.has(f));
    if (unknown.length > 0) {
      return { ok: false, status: 400, error: `Unknown column(s) for table "${existingWidget.sourceTable}": ${unknown.join(", ")}.` };
    }
  }

  const candidateWidget = {
    ...existingWidget,
    type: edit.type ?? existingWidget.type,
    fields: edit.fields ?? existingWidget.fields,
    aggregation: edit.aggregation ?? existingWidget.aggregation,
    position: edit.position ?? existingWidget.position,
  };

  const widgetCheck = dashboardWidgetSchema.safeParse(candidateWidget);

  if (!widgetCheck.success) {
    return { ok: false, status: 400, error: `Invalid widget shape: ${JSON.stringify(widgetCheck.error.issues)}` };
  }

  const candidateConfig: ResolvedDashboardConfigShape = {
    ...currentConfig,
    tabs: currentConfig.tabs.map((tab, t) =>
      t !== foundTabIndex
        ? tab
        : {
            ...tab,
            widgets: tab.widgets.map((w, i) => (i !== foundWidgetIndex ? w : widgetCheck.data)),
          },
    ),
  };

  // Same guard every other write path enforces -- a mechanical edit that
  // changes a chart's type or fields is exactly where this exact bug
  // (a near-unique column landing on a pie/bar axis) could be
  // reintroduced by a well-meaning but wrong request.
  const highCardinalityAxes = findHighCardinalityChartAxes(candidateConfig, tables);

  if (highCardinalityAxes.length > 0) {
    return { ok: false, status: 400, error: `This change would chart a near-unique column as a category axis: ${highCardinalityAxes.join("; ")}` };
  }

  const rawSchemaCheck = dashboardConfigSchema.safeParse({
    ...candidateConfig,
    insights: candidateConfig.insights, // resolved insights already satisfy the raw schema's metric shape too
  });

  if (!rawSchemaCheck.success) {
    return { ok: false, status: 400, error: `Resulting config failed schema validation: ${JSON.stringify(rawSchemaCheck.error.issues)}` };
  }

  const unresolvableMetrics = findUnresolvableMetrics(candidateConfig.insights, tables);

  if (unresolvableMetrics.length > 0) {
    return { ok: false, status: 400, error: `Resulting config has insight metrics that don't resolve: ${unresolvableMetrics.join("; ")}` };
  }

  const resolvedConfig: ResolvedDashboardConfigShape = {
    ...candidateConfig,
    insights: resolveInsightMetrics(candidateConfig.insights, tables),
  };

  const resolvedCheck = resolvedDashboardConfigSchema.safeParse(resolvedConfig);

  if (!resolvedCheck.success) {
    return { ok: false, status: 500, error: `Resolved config failed schema validation: ${JSON.stringify(resolvedCheck.error.issues)}` };
  }

  const priorConfigs = await payload.find({
    collection: "configs",
    where: { dataset: { equals: Number(datasetId) } },
    limit: 1,
    depth: 0,
    sort: "-version",
  });
  const nextVersion = (priorConfigs.docs[0]?.version ?? 0) + 1;

  await payload.create({
    collection: "configs",
    data: {
      dataset: Number(datasetId),
      version: nextVersion,
      config: resolvedCheck.data,
      insights: resolvedCheck.data.insights,
      generatedBy: CONFIG_SOURCE.directEdit,
    },
  });

  await publishEvent("config.updated", String(datasetId), null);

  return { ok: true, datasetId: String(datasetId), configVersion: nextVersion };
};
