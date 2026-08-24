import { CONFIG_SOURCE, type ResolvedDashboardConfigShape } from "@analytics/shared";
import type { Payload } from "payload";

import {
  buildTableInsight,
  logicalSheetGroup,
  parsedTablesFromNormalized,
  pickCountField,
  preferAverage,
  validateAndResolveCandidateConfig,
  type ParsedTable,
} from "./directIngestion";
import { loadSessionSources, relationshipIds } from "./sessionSources";

/**
 * Phase A for combined sessions -- the exact architectural counterpart of
 * processIngestionDirectly's deterministic fallback for datasets, closing
 * the second combine-sessions gap: when every AI attempt fails there, the
 * session used to be written ready with an empty overview (zero tabs, zero
 * findings), a genuinely useless Overview tab. From now on THIS runs first,
 * inside POST /api/sessions itself, before any AI is attempted anywhere:
 * a validated, working combined dashboard built deterministically from the
 * sources' already-stored rows, so the session is degraded-but-useful the
 * moment it exists, and the AI upgrade (Phase B, upgradeSessionOverviewFunction)
 * replaces it later only if it actually succeeds.
 *
 * Zero AI calls, zero file re-parses: everything here reads the stored
 * NormalizedTableShapes (via loadSessionSources, the same read-only loader
 * chat/edit use), never touches Files bytes, and completes in well under a
 * second. That is what lets POST /api/sessions stop blocking on AI entirely
 * -- the first gap -- without giving up "the Overview tab always shows
 * something real."
 *
 * One deliberate scoping decision, made against a verified renderer
 * constraint rather than taste: CombinedDashboardRenderer (DashboardRenderer.tsx)
 * fetches EVERY widget's rows through exactly one endpoint --
 * /api/datasets/${datasetId}/data with the single datasetId passed to it,
 * which SessionShellPage sets to session.datasets[0].id. A widget whose
 * sourceTable belongs to any OTHER dataset would 404 that lookup and render
 * as an error card, not a chart. So this builder sources all widgets from
 * the primary (first) dataset's tables only; every other dataset stays fully
 * visible through its own per-source tab (SessionShellPage renders those
 * independently, unchanged). The cross-source insight below still names the
 * other sources' real record counts in prose -- insight numbers are baked at
 * resolution time server-side, so prose figures need no live row fetch.
 * Widening the renderer to multi-dataset fetching is a separate, larger
 * change (it needs a tableName->owner map the frontend doesn't have today)
 * and is deliberately out of scope here.
 *
 * Honest limitation, documented rather than hidden: cross-source FINDINGS
 * are not produced here. sessionFindingSchema requires both a resolvable
 * dataset metric AND a verbatim document quote (resolveSessionFindings
 * verifies both sides); a quote can only come from the model that read the
 * document. Findings stay [] until Phase B succeeds -- or forever for
 * dataset-only sessions, where an empty findings array is the contract's own
 * correct answer, not a failure state.
 */

const realNumCols = (t: ParsedTable) =>
  t.columnsWithTypes.filter((c) => c.inferredType === "numeric");

// Broad: any column usable for a "Distinct X" KPI -- same rule as
// directIngestion's template (see its realCatCols comment).
const realCatCols = (t: ParsedTable) =>
  t.columnsWithTypes.filter(
    (c) => c.inferredType === "categorical" || c.inferredType === "text",
  );

// Narrow: columns safe to hand to a chart as the category axis --
// deliberately excludes "text" for the identical reason directIngestion's
// chartCatCols does (near-unique columns draw one slice/bar per row).
const chartCatCols = (t: ParsedTable) =>
  t.columnsWithTypes.filter(
    (c) => c.inferredType === "categorical" || c.inferredType === "boolean",
  );

export type DeterministicSessionOverviewResult =
  | { written: true }
  /**
   * No dataset in this session has stored tables (documents-only batch, or
   * every dataset lost its data). There is genuinely nothing deterministic
   * to build; the caller records the honest empty-overview outcome instead
   * of pretending a dashboard exists.
   */
  | { written: false; reason: "no_usable_dataset_tables" };

export const writeDeterministicSessionOverview = async (
  payload: Payload,
  sessionId: string,
  options?: { adminIntent?: string },
): Promise<DeterministicSessionOverviewResult> => {
  let session;

  try {
    session = await payload.findByID({ collection: "sessions", id: sessionId, depth: 0 });
  } catch {
    return { written: false, reason: "no_usable_dataset_tables" };
  }

  const datasetIds = relationshipIds(session.datasets);
  const documentIds = relationshipIds(session.documents);

  const { datasets } = await loadSessionSources(payload, datasetIds, documentIds);

  if (datasets.length === 0) {
    return { written: false, reason: "no_usable_dataset_tables" };
  }

  // See the file header for why widgets are scoped to the primary dataset.
  const primary = datasets[0]!;
  const otherDatasets = datasets.slice(1);
  const primaryTables = parsedTablesFromNormalized(primary.tables);

  if (primaryTables.length === 0) {
    return { written: false, reason: "no_usable_dataset_tables" };
  }

  const totalPrimaryRows = primaryTables.reduce((acc, t) => acc + t.rowCount, 0);

  // ---- Executive Overview tab (widgets from the primary dataset only) ----
  const overviewWidgets: any[] = [];

  overviewWidgets.push({
    widgetId: "ov_kpi_1",
    type: "kpi_card",
    title: "Total Volume",
    sourceTable: primaryTables[0]?.name ?? "Data",
    fields: [primaryTables[0]?.columns[0] ?? "id"],
    aggregation: "count",
    position: { col: 0, row: 0, w: 3, h: 2 },
  });

  // Group leaders only -- see the identically-named block in
  // directIngestion.ts's template for why sibling blocks are excluded here.
  const groupLeaderTables: ParsedTable[] = [];
  {
    const seenGroups = new Set<string>();
    for (const t of primaryTables) {
      const key = logicalSheetGroup(t.name);
      if (!seenGroups.has(key)) {
        seenGroups.add(key);
        groupLeaderTables.push(t);
      }
    }
  }

  groupLeaderTables.slice(0, 3).forEach((table, idx) => {
    const nums = realNumCols(table);
    if (nums[0]) {
      const useAvg = preferAverage(nums[0].name);
      overviewWidgets.push({
        widgetId: `ov_kpi_${idx + 2}`,
        type: "kpi_card",
        title: `${useAvg ? "Average" : "Total"} ${nums[0].name}`,
        sourceTable: table.name,
        fields: [nums[0].name],
        aggregation: useAvg ? "avg" : "sum",
        position: { col: (idx + 1) * 3, row: 0, w: 3, h: 2 },
      });
    } else {
      const cats = realCatCols(table);
      if (cats[0]) {
        overviewWidgets.push({
          widgetId: `ov_kpi_${idx + 2}`,
          type: "kpi_card",
          title: `Distinct ${cats[0].name}`,
          sourceTable: table.name,
          fields: [cats[0].name],
          aggregation: "distinct",
          position: { col: (idx + 1) * 3, row: 0, w: 3, h: 2 },
        });
      }
    }
  });

  if (primaryTables[0]) {
    const t0 = primaryTables[0];
    const cats = chartCatCols(t0);
    const nums = realNumCols(t0);
    const dates = t0.columnsWithTypes.filter((c) => c.inferredType === "date");
    const catCol = cats[0]?.name || dates[0]?.name;
    const numCol = nums[0]?.name;

    if (catCol) {
      overviewWidgets.push({
        widgetId: "ov_chart_1",
        type: "bar",
        title: `${t0.name} by ${catCol}`,
        sourceTable: t0.name,
        fields: numCol ? [catCol, numCol] : [catCol],
        aggregation: numCol ? "sum" : "count",
        position: { col: 0, row: 2, w: 6, h: 4 },
      });
    } else {
      // No low-cardinality axis exists -- a raw-rows table is always valid,
      // same reasoning as directIngestion's identical branch.
      overviewWidgets.push({
        widgetId: "ov_chart_1",
        type: "table",
        title: `${t0.name} Records`,
        sourceTable: t0.name,
        fields: t0.columns.slice(0, 6),
        aggregation: "none",
        position: { col: 0, row: 2, w: 6, h: 4 },
      });
    }
  }

  const t1 = groupLeaderTables[1] ?? groupLeaderTables[0];
  if (t1) {
    const cats = chartCatCols(t1);
    const catCol = cats[0]?.name;

    if (catCol) {
      overviewWidgets.push({
        widgetId: "ov_chart_2",
        type: "pie",
        title: `${t1.name} Distribution`,
        sourceTable: t1.name,
        fields: [catCol],
        aggregation: "count",
        position: { col: 6, row: 2, w: 6, h: 4 },
      });
    } else {
      overviewWidgets.push({
        widgetId: "ov_chart_2",
        type: "table",
        title: `${t1.name} Records`,
        sourceTable: t1.name,
        fields: t1.columns.slice(0, 6),
        aggregation: "none",
        position: { col: 6, row: 2, w: 6, h: 4 },
      });
    }
  }

  const generatedTabs: any[] = [
    {
      tabId: "executive_overview",
      tabName: "Executive Overview",
      widgets: overviewWidgets,
    },
  ];

  // ---- One specialized tab per LOGICAL sheet (grouped sub-tables) ----
  // Same grouping discipline as directIngestion's template: parsed blocks of
  // one underlying worksheet share a single tab, stacked vertically, so real
  // companion tables stay visible without duplicating tabs.
  const generatedInsights: any[] = [];

  const sheetGroups = new Map<string, ParsedTable[]>();
  for (const table of primaryTables) {
    const key = logicalSheetGroup(table.name);
    const list = sheetGroups.get(key);
    if (list) {
      list.push(table);
    } else {
      sheetGroups.set(key, [table]);
    }
  }

  let tabIndex = 0;
  let widgetIdCounter = 0;

  for (const [groupName, groupTables] of sheetGroups) {
    const widgets: any[] = [];
    let rowOffset = 0;

    for (const table of groupTables) {
      const tid = ++widgetIdCounter;
      const numCols = realNumCols(table);
      const catCols = realCatCols(table);
      const chartCats = chartCatCols(table);
      const dateCols = table.columnsWithTypes.filter((c) => c.inferredType === "date");

      widgets.push({
        widgetId: `t_${tid}_kpi_1`,
        type: "kpi_card",
        title: `${table.name} Records`,
        sourceTable: table.name,
        fields: [table.columns[0] ?? "id"],
        aggregation: "count",
        position: { col: 0, row: rowOffset, w: 4, h: 2 },
      });

      if (numCols[0]) {
        const useAvg = preferAverage(numCols[0].name);
        widgets.push({
          widgetId: `t_${tid}_kpi_2`,
          type: "kpi_card",
          title: `${useAvg ? "Average" : "Total"} ${numCols[0].name}`,
          sourceTable: table.name,
          fields: [numCols[0].name],
          aggregation: useAvg ? "avg" : "sum",
          position: { col: 4, row: rowOffset, w: 4, h: 2 },
        });
      }

      if (numCols[1] || numCols[0]) {
        const colToUse = numCols[1] ?? numCols[0];
        widgets.push({
          widgetId: `t_${tid}_kpi_3`,
          type: "kpi_card",
          title: `Average ${colToUse!.name}`,
          sourceTable: table.name,
          fields: [colToUse!.name],
          aggregation: "avg",
          position: { col: 8, row: rowOffset, w: 4, h: 2 },
        });
      } else if (catCols[0]) {
        widgets.push({
          widgetId: `t_${tid}_kpi_3`,
          type: "kpi_card",
          title: `Distinct ${catCols[0].name}`,
          sourceTable: table.name,
          fields: [catCols[0].name],
          aggregation: "distinct",
          position: { col: 8, row: rowOffset, w: 4, h: 2 },
        });
      }

      const xCol = chartCats[0]?.name || dateCols[0]?.name;
      const yCol = numCols[0]?.name;

      if (xCol) {
        widgets.push({
          widgetId: `t_${tid}_chart_1`,
          type: "bar",
          title: `${table.name} Breakdown by ${xCol}`,
          sourceTable: table.name,
          fields: yCol ? [xCol, yCol] : [xCol],
          aggregation: yCol ? "sum" : "count",
          position: { col: 0, row: rowOffset + 2, w: 6, h: 4 },
        });
      } else {
        widgets.push({
          widgetId: `t_${tid}_chart_1`,
          type: "table",
          title: `${table.name} Records`,
          sourceTable: table.name,
          fields: table.columns.slice(0, 6),
          aggregation: "none",
          position: { col: 0, row: rowOffset + 2, w: 6, h: 4 },
        });
      }

      if (dateCols[0] && numCols[0]) {
        widgets.push({
          widgetId: `t_${tid}_chart_2`,
          type: "line",
          title: `${numCols[0].name} Trend over ${dateCols[0].name}`,
          sourceTable: table.name,
          fields: [dateCols[0].name, numCols[0].name],
          aggregation: "sum",
          position: { col: 6, row: rowOffset + 2, w: 6, h: 4 },
        });
      } else if (chartCats[1] || (chartCats[0] && numCols[1])) {
        const secondX = chartCats[1]?.name ?? chartCats[0]!.name;
        const secondY = numCols[1]?.name ?? numCols[0]?.name;
        widgets.push({
          widgetId: `t_${tid}_chart_2`,
          type: "horizontal_bar",
          title: `${table.name} Analysis (${secondX})`,
          sourceTable: table.name,
          fields: secondY ? [secondX, secondY] : [secondX],
          aggregation: secondY ? "avg" : "count",
          position: { col: 6, row: rowOffset + 2, w: 6, h: 4 },
        });
      } else if (chartCats[0]) {
        widgets.push({
          widgetId: `t_${tid}_chart_2`,
          type: "pie",
          title: `${table.name} Share Distribution`,
          sourceTable: table.name,
          fields: [chartCats[0].name],
          aggregation: "count",
          position: { col: 6, row: rowOffset + 2, w: 6, h: 4 },
        });
      }

      rowOffset += 6;

      generatedInsights.push(buildTableInsight(table, `ins_${tid}`));
    }

    generatedTabs.push({
      tabId: `tab_${++tabIndex}`,
      tabName: groupName,
      widgets,
    });
  }

  // ---- Cross-source overview insight (real counts, baked prose) ----
  const largestTable = [...primaryTables].sort((a, b) => b.rowCount - a.rowCount)[0];
  const largestShare = largestTable ? largestTable.rowCount / Math.max(totalPrimaryRows, 1) : 0;

  const otherDatasetParts = otherDatasets.map((d) => {
    const rows = d.tables.reduce((acc, t) => acc + t.rows.length, 0);
    return `${d.datasetName} (${rows} record${rows === 1 ? "" : "s"})`;
  });
  const documentParts = documentIds.length > 0 ? ["the uploaded document(s)"] : [];
  const companionParts = [...otherDatasetParts, ...documentParts];

  generatedInsights.unshift({
    insightId: "ins_overview",
    finding: [
      `This combined workspace spans ${datasets.length} dataset${datasets.length === 1 ? "" : "s"}${
        documentIds.length > 0 ? ` and ${documentIds.length} document${documentIds.length === 1 ? "" : "s"}` : ""
      }.`,
      `The primary dataset "${primary.datasetName}" holds ${totalPrimaryRows} record${totalPrimaryRows === 1 ? "" : "s"} across ${primaryTables.length} table${primaryTables.length === 1 ? "" : "s"}.`,
      largestTable
        ? `${largestTable.name} accounts for the largest share, with ${largestTable.rowCount} records (${Math.round(largestShare * 100)}% of the primary dataset's total).`
        : "",
      companionParts.length > 0
        ? `Also part of this workspace: ${companionParts.join(", ")} -- each keeps its own full treatment on its own tab above.`
        : "",
    ]
      .filter(Boolean)
      .join(" "),
    whyItMatters: `Knowing which source carries the most records shows where review effort should start, while the remaining sources stay one click away on their own tabs.`,
    recommendedAction: `Review ${largestTable?.name ?? primary.datasetName} first given its share of total volume, then work through the remaining sources by size.`,
    severity: "info",
    presentation: {
      shape: "tracker-item",
      status: "Tracked",
      owner: "Operations Lead",
    },
    relatedTables: primaryTables.map((t) => t.name),
    // Same discipline as directIngestion's ins_overview: the cross-source
    // total doesn't fit either metric-reference kind (one sourceTable max),
    // so it lives in the finding sentence; largestTable's own count does fit.
    metrics: largestTable
      ? [
          {
            kind: "aggregate",
            label: `${largestTable.name} Records`,
            sourceTable: largestTable.name,
            sourceField: pickCountField(largestTable),
            aggregation: "count",
          },
        ]
      : [],
  });

  // ---- Validate through the shared four-check gate, then store ----
  const candidate = {
    datasetId: primary.datasetId,
    title:
      options?.adminIntent?.trim() ||
      (typeof session.name === "string" && session.name.trim().length > 0
        ? session.name.trim()
        : "Executive Overview"),
    tabs: generatedTabs,
    insights: generatedInsights,
  };

  // Throws on any check failure -- the caller treats that as "no fallback
  // was written" and records the honest empty outcome, exactly like a
  // failed AI attempt would leave things today. It must never store a
  // partially valid config (CLAUDE.md rule 1).
  const resolved: ResolvedDashboardConfigShape = await validateAndResolveCandidateConfig(
    candidate,
    primaryTables,
    "session fallback combined dashboard",
  );

  await payload.update({
    collection: "sessions",
    id: sessionId,
    data: {
      status: "ready",
      overview: {
        config: resolved,
        findings: [],
        // Marks this overview as the fast deterministic template so the
        // session page knows to keep polling for the AI upgrade (Phase B)
        // -- and so GET /api/sessions/:id skips its cache while this is
        // still the live version. Same vocabulary as Configs.generatedBy.
        configSource: CONFIG_SOURCE.initialFallback,
      },
    },
  });

  return { written: true };
};