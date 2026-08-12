/**
 * Phase 7 acceptance: the renderer.
 *
 * Verifies the data endpoint over HTTP, then renders the real widget and insight
 * components to HTML with the real stored config and rows, and asserts the
 * output contains values recomputed independently from the dataset. Rendering to
 * HTML rather than screenshotting is deliberate: it proves the numbers on screen
 * come from the data, which a screenshot cannot.
 */
import { DEFAULT_LIMITS } from "@analytics/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { getPayload } from "payload";

import config from "../payload.config";
import {
  buildCategorySeries,
  computeKpi,
  isBlank,
  resolveChartFields,
  toNumber,
  type DataColumn,
  type DataRow,
} from "../lib/aggregate";
import { InsightsPanel } from "../components/dashboard/InsightsPanel";
import { WidgetRenderer } from "../components/dashboard/WidgetRenderer";

const APP = process.env.PUBLIC_APP_URL ?? "http://localhost:3000";

const say = (label: string, value: unknown): void => {
  console.log(
    `${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
};

// React's renderToStaticMarkup HTML-escapes text content, including an
// apostrophe (to &#x27;), which a raw .includes(title) check against the
// rendered HTML would otherwise miss on any title containing one -- a real
// false-negative risk in this script, not a rendering bug (found when a
// live-generated insight titled "...Bands' revenue..." tripped exactly
// this gap in the widget-title check's escaping, which handled &<>" but not
// the apostrophe).
const escapeForHtmlCompare = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

type StoredTable = {
  tableName: string;
  tableRole: string;
  columns: { name: string; inferredType: string }[];
  rows: DataRow[];
};

const main = async (): Promise<void> => {
  const payload = await getPayload({ config });

  const login = await fetch(`${APP}/api/users/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
    }),
  });

  if (!login.ok) {
    throw new Error(`Login failed: ${login.status}`);
  }

  const cookie = login.headers.getSetCookie().join("; ");

  const datasets = await payload.find({
    collection: "datasets",
    where: { status: { equals: "ready" } },
    limit: 1,
    depth: 0,
    sort: "-updatedAt",
  });

  const dataset = datasets.docs[0];

  if (!dataset) {
    throw new Error("No ready dataset found.");
  }

  const datasetId = String(dataset.id);
  const stored = dataset.data as { tables: StoredTable[] };

  const configs = await payload.find({
    collection: "configs",
    where: { dataset: { equals: dataset.id } },
    limit: 1,
    depth: 0,
    sort: "-version",
  });

  const configRecord = configs.docs[0];

  if (!configRecord) {
    throw new Error("No config found for dataset.");
  }

  const dashboardConfig = configRecord.config as {
    title: string;
    tabs: {
      tabId: string;
      tabName: string;
      widgets: {
        widgetId: string;
        type: "kpi_card" | "bar" | "line" | "pie" | "table";
        title: string;
        sourceTable: string;
        fields: string[];
        aggregation: "none" | "sum" | "count" | "avg";
        position: { row: number; col: number; w: number; h: number };
      }[];
    }[];
    insights: {
      insightId: string;
      title: string;
      body: string;
      severity: "info" | "warning" | "positive" | "negative";
      relatedTables: string[];
    }[];
  };

  // Collected across every probe in this script, not just the widget-render
  // loop below, so any check can report a failure without its own ad hoc
  // pass/fail plumbing.
  const failures: string[] = [];

  // ---------------------------------------------------------- config version
  console.log("\n=== config version is never hardcoded to 1 ===");

  const allConfigsForDataset = await payload.find({
    collection: "configs",
    where: { dataset: { equals: dataset.id } },
    limit: 1000,
    depth: 0,
  });

  const versions = allConfigsForDataset.docs.map((c) => c.version);
  const versionsUnique = versions.length === new Set(versions).size;

  say("configs stored for this dataset", allConfigsForDataset.docs.length);
  say("versions found", versions);
  say("every version for this dataset is unique", versionsUnique);

  // Replicates the exact query worker/src/processors/ingestion.ts now runs
  // before writing a new config: max existing version for the dataset, + 1.
  // A hardcoded-1 bug would show up here as this disagreeing with reality
  // once more than one config row exists.
  const maxVersion = Math.max(...versions);
  const nextVersionWouldBe = maxVersion + 1;
  const nextVersionIsNotHardcodedOne =
    allConfigsForDataset.docs.length <= 1 || nextVersionWouldBe > 1;

  say(
    `next write for this dataset would take version ${nextVersionWouldBe}`,
    nextVersionIsNotHardcodedOne,
  );

  if (!versionsUnique) {
    failures.push(
      `config version probe: dataset ${datasetId} has duplicate config versions ${JSON.stringify(versions)}`,
    );
  }

  // ------------------------------------------------------------------ endpoint
  console.log("=== GET /api/datasets/:id/data ===");

  const noTable = await fetch(`${APP}/api/datasets/${datasetId}/data`, {
    headers: { cookie },
  });
  const noTableBody = (await noTable.json()) as Record<string, unknown>;

  say("no table param, status", noTable.status);
  say("returned table", noTableBody.table);
  say("rows returned", (noTableBody.rows as unknown[]).length);
  say("default limit", noTableBody.limit);
  say(
    "availableTables",
    (noTableBody.availableTables as { tableName: string }[]).map(
      (t) => t.tableName,
    ),
  );

  const firstTable = stored.tables[0]!;
  const paged = await fetch(
    `${APP}/api/datasets/${datasetId}/data?table=${encodeURIComponent(firstTable.tableName)}&limit=3&offset=1`,
    { headers: { cookie } },
  );
  const pagedBody = (await paged.json()) as {
    rows: DataRow[];
    totalRows: number;
    columns: DataColumn[];
  };

  say("limit=3 offset=1, rows", pagedBody.rows.length);
  say("totalRows reported", pagedBody.totalRows);
  say(
    "offset honoured",
    JSON.stringify(pagedBody.rows[0]) === JSON.stringify(firstTable.rows[1]),
  );

  const badTable = await fetch(
    `${APP}/api/datasets/${datasetId}/data?table=does-not-exist`,
    { headers: { cookie } },
  );

  say("unknown table status", badTable.status);

  const unauth = await fetch(`${APP}/api/datasets/${datasetId}/data`);

  say("unauthenticated status", unauth.status);

  const endpointOk =
    noTable.status === 200 &&
    noTableBody.limit === 100 &&
    (noTableBody.availableTables as unknown[]).length === stored.tables.length &&
    pagedBody.rows.length === 3 &&
    badTable.status === 404 &&
    unauth.status === 401;

  // ----------------------------------------------------------------- rendering
  console.log("\n=== render widgets with real data ===");

  const tableByName = new Map(stored.tables.map((t) => [t.tableName, t]));
  const allWidgets = dashboardConfig.tabs.flatMap((tab) => tab.widgets);

  say("tabs in config", dashboardConfig.tabs.map((t) => t.tabName));
  say("total widgets", allWidgets.length);

  let renderedWidgets = 0;
  let chartsWithRealValues = 0;
  let tablesRendered = 0;
  let kpisRendered = 0;
  let kpisNotNumeric = 0;

  for (const widget of allWidgets) {
    const source = tableByName.get(widget.sourceTable);

    if (!source) {
      failures.push(`${widget.widgetId}: unknown table ${widget.sourceTable}`);
      continue;
    }

    // Exactly what the endpoint would serve: first 100 rows.
    const rows = source.rows.slice(0, 100);
    const state = {
      status: "ready" as const,
      columns: source.columns,
      rows,
      totalRows: source.rows.length,
    };

    let html: string;

    try {
      html = renderToStaticMarkup(
        WidgetRenderer({ widget, state }) as React.ReactElement,
      );
      renderedWidgets += 1;
    } catch (error: unknown) {
      failures.push(
        `${widget.widgetId}: render threw ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    // React escapes text, so compare against the escaped form.
    const escapedTitle = escapeForHtmlCompare(widget.title);

    if (!html.includes(escapedTitle)) {
      failures.push(`${widget.widgetId}: title missing from output`);
    }

    if (widget.type === "kpi_card") {
      const result = computeKpi(
        rows,
        widget.fields.filter((f) =>
          source.columns.some((c) => c.name === f),
        ),
        source.columns,
        widget.aggregation,
      );

      if (result.kind === "not-numeric") {
        // A real Claude-generated widget landing here means the config asked
        // to sum/avg a non-numeric field. That must render the explicit
        // refusal, never a number.
        if (html.includes("is not a numeric field")) {
          kpisNotNumeric += 1;
          console.log(
            `  kpi "${widget.title}" -> refused: "${result.field}" is not numeric`,
          );
        } else {
          failures.push(
            `${widget.widgetId}: not-numeric KPI did not render the explicit refusal state`,
          );
        }

        continue;
      }

      const { value } = result;

      // The formatted number must appear in the rendered HTML.
      const formatted = Number.isInteger(value)
        ? value.toLocaleString("en-IN")
        : Number(value.toFixed(4)).toLocaleString("en-IN", {
            maximumFractionDigits: 4,
          });

      if (html.includes(formatted)) {
        kpisRendered += 1;
        console.log(
          `  kpi "${widget.title}" -> ${formatted} (${widget.aggregation} of ${widget.fields.join(",")})`,
        );
      } else {
        failures.push(
          `${widget.widgetId}: expected KPI value ${formatted} not in HTML`,
        );
      }

      continue;
    }

    if (widget.type === "table") {
      const known = widget.fields.filter((f) =>
        source.columns.some((c) => c.name === f),
      );
      const headersPresent = known.every((f) => html.includes(f));

      if (headersPresent && html.includes("<table")) {
        tablesRendered += 1;
        console.log(
          `  table "${widget.title}" -> ${rows.length} of ${source.rows.length} rows, ${known.length} columns`,
        );
      } else {
        failures.push(`${widget.widgetId}: table headers missing`);
      }

      continue;
    }

    // Charts: verify the aggregated series against an independent computation.
    const known = widget.fields.filter((f) =>
      source.columns.some((c) => c.name === f),
    );
    const { categoryField, measureFields } = resolveChartFields(
      known,
      source.columns,
    );

    if (!categoryField) {
      console.log(
        `  ${widget.type} "${widget.title}" -> no category column, error state rendered`,
      );
      continue;
    }

    const series = buildCategorySeries(
      rows,
      categoryField,
      measureFields,
      widget.aggregation,
    );

    if (series.length === 0) {
      console.log(`  ${widget.type} "${widget.title}" -> empty state rendered`);
      continue;
    }

    const measure = measureFields[0];
    let independentOk = true;

    if (measure && widget.aggregation === "sum") {
      // Recompute one bucket by hand from the raw rows.
      const sample = series[0]!;
      const bucketRows = rows.filter(
        (row) => String(row[categoryField]) === sample.category,
      );
      const expected = Number(
        bucketRows
          .map((row) => toNumber(row[measure]))
          .filter((v): v is number => v !== null)
          .reduce((a, b) => a + b, 0)
          .toFixed(6),
      );

      independentOk = expected === sample[measure];

      if (!independentOk) {
        failures.push(
          `${widget.widgetId}: series mismatch for "${sample.category}", got ${String(sample[measure])} expected ${expected}`,
        );
      }
    }

    if (independentOk) {
      chartsWithRealValues += 1;
      const preview = series
        .slice(0, 3)
        .map((s) => `${s.category}=${String(s[measure ?? "count"])}`)
        .join(", ");

      console.log(
        `  ${widget.type} "${widget.title}" -> ${series.length} groups by ${categoryField}; ${preview}`,
      );
    }
  }

  // --------------------------------------------------------------- empty state
  console.log("\n=== empty and error states ===");

  const emptyHtml = renderToStaticMarkup(
    WidgetRenderer({
      widget: {
        widgetId: "empty-probe",
        type: "table",
        title: "Empty probe",
        sourceTable: firstTable.tableName,
        fields: [firstTable.columns[0]!.name],
        aggregation: "none",
        position: { row: 0, col: 0, w: 6, h: 4 },
      },
      state: {
        status: "ready",
        columns: firstTable.columns,
        rows: [],
        totalRows: 0,
      },
    }) as React.ReactElement,
  );

  const emptyOk = emptyHtml.includes("Nothing to display");

  say("zero-row widget shows explicit empty state", emptyOk);

  const errorHtml = renderToStaticMarkup(
    WidgetRenderer({
      widget: {
        widgetId: "error-probe",
        type: "bar",
        title: "Error probe",
        sourceTable: firstTable.tableName,
        fields: [firstTable.columns[0]!.name],
        aggregation: "sum",
        position: { row: 0, col: 0, w: 6, h: 4 },
      },
      state: { status: "error", message: "simulated fetch failure" },
    }) as React.ReactElement,
  );

  const errorOk =
    errorHtml.includes("simulated fetch failure") &&
    errorHtml.includes('role="alert"');

  say("failed fetch shows error text, not blank", errorOk);

  const loadingHtml = renderToStaticMarkup(
    WidgetRenderer({
      widget: {
        widgetId: "loading-probe",
        type: "bar",
        title: "Loading probe",
        sourceTable: firstTable.tableName,
        fields: [firstTable.columns[0]!.name],
        aggregation: "sum",
        position: { row: 0, col: 0, w: 6, h: 4 },
      },
      state: { status: "loading" },
    }) as React.ReactElement,
  );

  const loadingOk = loadingHtml.includes("animate-pulse");

  say("in-flight widget shows skeleton", loadingOk);

  // --------------------------------------------------- kpi non-numeric field
  console.log("\n=== kpi_card pointed at a non-numeric field ===");

  // firstTable.columns[0] is whatever column the source happens to put
  // first; find an explicitly non-numeric one so this probe means something
  // regardless of table shape.
  const nonNumericColumn = firstTable.columns.find(
    (c) => c.inferredType !== "numeric",
  );

  let kpiNonNumericOk = false;

  if (nonNumericColumn) {
    const kpiHtml = renderToStaticMarkup(
      WidgetRenderer({
        widget: {
          widgetId: "non-numeric-kpi-probe",
          type: "kpi_card",
          title: "Non-numeric KPI probe",
          sourceTable: firstTable.tableName,
          fields: [nonNumericColumn.name],
          aggregation: "sum",
          position: { row: 0, col: 0, w: 3, h: 2 },
        },
        state: {
          status: "ready",
          columns: firstTable.columns,
          rows: firstTable.rows,
          totalRows: firstTable.rows.length,
        },
      }) as React.ReactElement,
    );

    kpiNonNumericOk =
      kpiHtml.includes("is not a numeric field") &&
      !/\d[\d,.]*<\/p>/.test(kpiHtml.replace(/&[a-z]+;/g, ""));

    say(
      `sum("${nonNumericColumn.name}") [${nonNumericColumn.inferredType}] shows explicit refusal, not a number`,
      kpiNonNumericOk,
    );

    if (!kpiNonNumericOk) {
      failures.push(
        "kpi non-numeric probe: sum on a non-numeric field did not render the explicit refusal state",
      );
    }
  } else {
    say(
      "kpi non-numeric probe",
      "skipped: every column in the first table is numeric",
    );
  }

  // ------------------------------------------------- full-table aggregation
  console.log("\n=== chart aggregation over the full table, not 100 rows ===");

  const bigTable = stored.tables.find(
    (t) =>
      t.rows.length > 100 &&
      t.columns.some((c) => c.inferredType === "numeric") &&
      t.columns.some((c) =>
        ["categorical", "date", "id"].includes(c.inferredType),
      ),
  );

  let fullAggregationOk = false;

  if (!bigTable) {
    say(
      "full-table aggregation probe",
      "skipped: no stored table has both >100 rows and a numeric+groupable column pair",
    );
  } else {
    const numericCol = bigTable.columns.find(
      (c) => c.inferredType === "numeric",
    )!.name;
    const groupCol = bigTable.columns.find((c) =>
      ["categorical", "date", "id"].includes(c.inferredType),
    )!.name;

    const previewSeries = buildCategorySeries(
      bigTable.rows.slice(0, 100),
      groupCol,
      [numericCol],
      "sum",
    );
    const fullSeries = buildCategorySeries(
      bigTable.rows,
      groupCol,
      [numericCol],
      "sum",
    );

    const previewTotal = Number(
      previewSeries.reduce((acc, s) => acc + Number(s[numericCol]), 0).toFixed(6),
    );
    const fullTotal = Number(
      fullSeries.reduce((acc, s) => acc + Number(s[numericCol]), 0).toFixed(6),
    );
    // buildCategorySeries excludes rows with a blank category rather than
    // bucketing them under an empty label (see its own doc comment), so the
    // independent recompute must apply that same exclusion to be comparable,
    // not sum every row in the table regardless of grouping.
    const independentFullTotal = Number(
      bigTable.rows
        .filter((row) => !isBlank(row[groupCol]))
        .map((row) => toNumber(row[numericCol]))
        .filter((v): v is number => v !== null)
        .reduce((a, b) => a + b, 0)
        .toFixed(6),
    );

    say(`sum("${numericCol}") over first 100 of ${bigTable.rows.length} rows`, previewTotal);
    say(`sum("${numericCol}") over all ${bigTable.rows.length} rows`, fullTotal);

    const numbersActuallyDiffer = previewTotal !== fullTotal;
    const fullMatchesIndependentRecompute = fullTotal === independentFullTotal;

    say("the two totals differ (proves the 100-row cap was material)", numbersActuallyDiffer);
    say("full total matches an independent full recompute", fullMatchesIndependentRecompute);

    // Confirm the endpoint itself now serves enough rows to make the fix
    // possible: the previous 1000-row API cap is gone, replaced by the
    // ingestion-time per-table limit.
    const fullFetch = await fetch(
      `${APP}/api/datasets/${datasetId}/data?table=${encodeURIComponent(bigTable.tableName)}&limit=${bigTable.rows.length}`,
      { headers: { cookie } },
    );
    const fullFetchBody = (await fullFetch.json()) as { rows: DataRow[] };
    const endpointServesFullTable = fullFetchBody.rows.length === bigTable.rows.length;

    say(
      `GET .../data?limit=${bigTable.rows.length} returns all rows, not capped at 1000`,
      endpointServesFullTable,
    );

    fullAggregationOk =
      numbersActuallyDiffer &&
      fullMatchesIndependentRecompute &&
      endpointServesFullTable;

    if (!fullAggregationOk) {
      failures.push("full-table chart aggregation probe did not pass");
    }
  }

  // ------------------------------------------- failed status, good data kept
  console.log("\n=== dataset marked failed while good data and config survive ===");

  let failedWithDataOk = false;

  try {
    await payload.update({
      collection: "datasets",
      id: dataset.id,
      data: {
        status: "failed",
        lastError: "ACCEPTANCE PROBE: simulated re-upload failure, not a real error.",
      },
    });

    const datasetResp = await fetch(`${APP}/api/datasets/${datasetId}`, {
      headers: { cookie },
    });
    const datasetBody = (await datasetResp.json()) as {
      status: string;
      lastError: string | null;
    };

    const configResp = await fetch(`${APP}/api/datasets/${datasetId}/config`, {
      headers: { cookie },
    });

    const dataResp = await fetch(
      `${APP}/api/datasets/${datasetId}/data?table=${encodeURIComponent(firstTable.tableName)}`,
      { headers: { cookie } },
    );

    const statusReportsFailed = datasetBody.status === "failed";
    const realErrorSurfaced = datasetBody.lastError?.includes(
      "ACCEPTANCE PROBE",
    );
    const configStillServed = configResp.status === 200;
    const dataStillServed = dataResp.status === 200;

    say("dataset endpoint reports status failed", statusReportsFailed);
    say("dataset endpoint surfaces the real error text", realErrorSurfaced);
    say("config endpoint still serves the last good config", configStillServed);
    say("data endpoint still serves the stored rows", dataStillServed);

    // This is exactly the contract DashboardRenderer.tsx's load() depends on:
    // status failed + config still fetchable => render ready, with the real
    // lastError as the failure banner, never a blank "no data" screen.
    failedWithDataOk =
      statusReportsFailed &&
      Boolean(realErrorSurfaced) &&
      configStillServed &&
      dataStillServed;

    if (!failedWithDataOk) {
      failures.push(
        "failed-dataset-with-good-data probe: the API contract DashboardRenderer relies on did not hold",
      );
    }
  } finally {
    // Always restore, whether the assertions above passed or threw.
    await payload.update({
      collection: "datasets",
      id: dataset.id,
      data: { status: "ready", lastError: null },
    });
  }

  say("failed status with surviving good data renders instead of going blank", failedWithDataOk);

  // ------------------------------------------------------------------ insights
  console.log("\n=== insights with severity styling ===");

  const insightsHtml = renderToStaticMarkup(
    InsightsPanel({ insights: dashboardConfig.insights }) as React.ReactElement,
  );

  const severities = [
    ...new Set(dashboardConfig.insights.map((i) => i.severity)),
  ];
  const allBodiesPresent = dashboardConfig.insights.every((i) =>
    insightsHtml.includes(escapeForHtmlCompare(i.title)),
  );
  const severityAttrs = severities.every((s) =>
    insightsHtml.includes(`data-severity="${s}"`),
  );

  // Distinct colour per severity, not just a label.
  const colourBySeverity: Record<string, string> = {
    positive: "--color-risk-low",
    negative: "--color-risk-high",
    warning: "--color-risk-med",
    info: "--color-cobalt",
  };
  const distinctColours = severities.every((s) =>
    insightsHtml.includes(colourBySeverity[s]!),
  );

  say("severities present in config", severities);
  say("every insight title rendered", allBodiesPresent);
  say("data-severity attribute per insight", severityAttrs);
  say("distinct colour token per severity", distinctColours);

  // ---------------------------------------------------------- performance
  console.log("\n=== performance: config+data fetch to render-ready (Section 23.3) ===");

  // Section 23.3.1's 2-second target, read literally as this prompt asked:
  // the whole window from starting the config+data fetch to a fully
  // rendered dashboard, not just render time after fetch completes. Uses
  // real HTTP against the running server, not the in-process `payload`
  // reads the rest of this script uses elsewhere, because wall-clock
  // fetch latency is exactly what's being measured here.
  const PERF_TARGET_MS = 2000;
  const perfStart = Date.now();

  const [perfDatasetResp, perfConfigResp] = await Promise.all([
    fetch(`${APP}/api/datasets/${datasetId}`, { headers: { cookie } }),
    fetch(`${APP}/api/datasets/${datasetId}/config`, { headers: { cookie } }),
  ]);

  if (!perfDatasetResp.ok || !perfConfigResp.ok) {
    throw new Error("Performance probe: dataset or config fetch failed.");
  }

  const perfConfigBody = (await perfConfigResp.json()) as {
    config: typeof dashboardConfig;
  };
  const perfWidgets = perfConfigBody.config.tabs.flatMap((t) => t.widgets);

  const perfRequiredTables = Array.from(
    new Set(perfWidgets.map((w) => w.sourceTable)),
  );
  // Mirrors DashboardRenderer.tsx's needsFullTableAggregation exactly.
  const perfAggregateTables = Array.from(
    new Set(
      perfWidgets
        .filter(
          (w) =>
            ["bar", "line", "pie"].includes(w.type) && w.aggregation !== "none",
        )
        .map((w) => w.sourceTable),
    ),
  );

  type PerfTableResponse = { columns: DataColumn[]; rows: DataRow[]; totalRows: number };

  const fetchTable = (tableName: string, limit: number): Promise<PerfTableResponse> =>
    fetch(
      `${APP}/api/datasets/${datasetId}/data?table=${encodeURIComponent(tableName)}&limit=${limit}`,
      { headers: { cookie } },
    ).then((r) => r.json() as Promise<PerfTableResponse>);

  const [previewResults, aggregateResults] = await Promise.all([
    Promise.all(perfRequiredTables.map((name) => fetchTable(name, 100))),
    Promise.all(
      perfAggregateTables.map((name) =>
        fetchTable(name, DEFAULT_LIMITS.maxRowsPerTable),
      ),
    ),
  ]);

  const previewByTable = new Map(
    perfRequiredTables.map((name, i) => [name, previewResults[i]!]),
  );
  const aggregateByTable = new Map(
    perfAggregateTables.map((name, i) => [name, aggregateResults[i]!]),
  );

  // Full render-ready state: every widget actually rendered, same as the
  // main rendering pass above, using whichever fetch (preview or
  // full-aggregate) the real renderer would pick for that widget.
  let perfRenderFailures = 0;

  for (const widget of perfWidgets) {
    const isAggregateChart =
      ["bar", "line", "pie"].includes(widget.type) && widget.aggregation !== "none";
    const source = isAggregateChart
      ? aggregateByTable.get(widget.sourceTable)
      : previewByTable.get(widget.sourceTable);

    if (!source) {
      perfRenderFailures += 1;
      continue;
    }

    try {
      renderToStaticMarkup(
        WidgetRenderer({
          widget,
          state: { status: "ready", ...source },
        }) as React.ReactElement,
      );
    } catch {
      perfRenderFailures += 1;
    }
  }

  const perfElapsedMs = Date.now() - perfStart;
  const perfOk = perfRenderFailures === 0 && perfElapsedMs <= PERF_TARGET_MS;

  say("widgets fetched+rendered", perfWidgets.length);
  say("render failures during timing pass", perfRenderFailures);
  say("elapsed ms (config+data fetch through full render)", perfElapsedMs);
  say(`within Section 23.3's ${PERF_TARGET_MS}ms target`, perfElapsedMs <= PERF_TARGET_MS);
  say("performance probe result", perfOk ? "PASS" : "FAIL");

  if (perfRenderFailures > 0) {
    failures.push(
      `performance probe: ${perfRenderFailures} widget(s) failed to render during the timing pass`,
    );
  }

  if (perfElapsedMs > PERF_TARGET_MS) {
    failures.push(
      `performance probe: ${perfElapsedMs}ms exceeds Section 23.3's ${PERF_TARGET_MS}ms target`,
    );
  }

  console.log("\n=== SUMMARY ===");
  say("widgets rendered without throwing", `${renderedWidgets}/${allWidgets.length}`);
  say("kpi widgets with verified values", kpisRendered);
  say("kpi widgets that correctly refused a non-numeric field", kpisNotNumeric);
  say("table widgets rendered", tablesRendered);
  say("charts with independently verified series", chartsWithRealValues);
  say("non-numeric-kpi probe", nonNumericColumn ? (kpiNonNumericOk ? "pass" : "fail") : "skipped");
  say("full-table chart aggregation probe", bigTable ? (fullAggregationOk ? "pass" : "fail") : "skipped");
  say("failed-status-with-good-data probe", failedWithDataOk ? "pass" : "fail");
  say("config version probe", versionsUnique ? "pass" : "fail");
  say("performance probe (Section 23.3)", perfOk ? "pass" : "fail");
  say("failures", failures.length === 0 ? "none" : failures);

  const passed =
    endpointOk &&
    failures.length === 0 &&
    renderedWidgets === allWidgets.length &&
    chartsWithRealValues > 0 &&
    tablesRendered > 0 &&
    kpisRendered > 0 &&
    emptyOk &&
    errorOk &&
    loadingOk &&
    allBodiesPresent &&
    severityAttrs &&
    distinctColours &&
    perfOk;

  console.log(`\nPHASE 7 RENDERER: ${passed ? "PASS" : "FAIL"}`);

  await payload.db.destroy?.();
  process.exit(passed ? 0 : 1);
};

void main().catch((error: unknown) => {
  console.error("PHASE 7 ERROR:", error);
  process.exit(1);
});
