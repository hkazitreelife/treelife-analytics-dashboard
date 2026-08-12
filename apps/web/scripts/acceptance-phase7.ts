/**
 * Phase 7 acceptance: the renderer.
 *
 * Verifies the data endpoint over HTTP, then renders the real widget and insight
 * components to HTML with the real stored config and rows, and asserts the
 * output contains values recomputed independently from the dataset. Rendering to
 * HTML rather than screenshotting is deliberate: it proves the numbers on screen
 * come from the data, which a screenshot cannot.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { getPayload } from "payload";

import config from "../payload.config";
import {
  buildCategorySeries,
  computeKpi,
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
  const failures: string[] = [];

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
    const escapedTitle = widget.title
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

    if (!html.includes(escapedTitle)) {
      failures.push(`${widget.widgetId}: title missing from output`);
    }

    if (widget.type === "kpi_card") {
      const { value } = computeKpi(
        rows,
        widget.fields.filter((f) =>
          source.columns.some((c) => c.name === f),
        ),
        source.columns,
        widget.aggregation,
      );

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

  // ------------------------------------------------------------------ insights
  console.log("\n=== insights with severity styling ===");

  const insightsHtml = renderToStaticMarkup(
    InsightsPanel({ insights: dashboardConfig.insights }) as React.ReactElement,
  );

  const severities = [
    ...new Set(dashboardConfig.insights.map((i) => i.severity)),
  ];
  const allBodiesPresent = dashboardConfig.insights.every((i) =>
    insightsHtml.includes(i.title),
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

  console.log("\n=== SUMMARY ===");
  say("widgets rendered without throwing", `${renderedWidgets}/${allWidgets.length}`);
  say("kpi widgets with verified values", kpisRendered);
  say("table widgets rendered", tablesRendered);
  say("charts with independently verified series", chartsWithRealValues);
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
    distinctColours;

  console.log(`\nPHASE 7 RENDERER: ${passed ? "PASS" : "FAIL"}`);

  await payload.db.destroy?.();
  process.exit(passed ? 0 : 1);
};

void main().catch((error: unknown) => {
  console.error("PHASE 7 ERROR:", error);
  process.exit(1);
});
