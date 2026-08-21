/**
 * Ingestion smoke test: uploads a real .xlsx end-to-end through the actual
 * /api/uploads route, waits for the job to finish, then asserts the
 * result against every bug found and fixed in this session. Every check
 * is structural (table names, row counts, column types read back from
 * the API, not hardcoded expectations about this one fixture's content),
 * so it holds for whatever file is actually uploaded in production, not
 * just the bundled fixture.
 *
 * Run: pnpm --filter @analytics/web acceptance:ingestion-smoke
 * Requires the web process running on PUBLIC_APP_URL (default
 * localhost:3000) and ADMIN_EMAIL/ADMIN_PASSWORD in .env.local, same as
 * acceptance-phase7.ts. Point SMOKE_FIXTURE_PATH at a different .xlsx to
 * test a different shape (e.g. more sheets) without editing this file.
 *
 * Cleans up after itself via DELETE /api/sessions/:id, which cascades to
 * the dataset/job/config/file it wraps -- repeated runs never accumulate
 * test data. If the fixture's hash collides with a dataset left over from
 * a run that crashed before cleanup, that leftover is deleted and the
 * upload retried once rather than short-circuiting into a stale
 * "duplicate" (Files.sha256 identity, CLAUDE.md rule 4).
 */
import fs from "node:fs";
import path from "node:path";

const APP = process.env.PUBLIC_APP_URL ?? "http://localhost:3000";
const FIXTURE_PATH =
  process.env.SMOKE_FIXTURE_PATH ??
  path.resolve(process.cwd(), "media/treelife-fy27-demo-dataset-v2.xlsx");
const POLL_INTERVAL_MS = 3000;
const MAX_WAIT_MS = 5 * 60 * 1000;

const failures: string[] = [];

const say = (label: string, value: unknown): void => {
  console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
};

const check = (label: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    const message = `${label}${detail ? ` (${detail})` : ""}`;
    failures.push(message);
    console.error(`  ❌ ${message}`);
  }
};

type UploadResponse = {
  jobId?: string;
  datasetId?: string;
  status?: string;
  error?: string;
  existingDatasetId?: string;
  requiresUserChoice?: boolean;
};

const main = async (): Promise<void> => {
  console.log(`=== Ingestion smoke test against ${APP} ===`);

  if (!fs.existsSync(FIXTURE_PATH)) {
    throw new Error(
      `Fixture not found at ${FIXTURE_PATH}. Set SMOKE_FIXTURE_PATH to point at a real .xlsx file.`,
    );
  }

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
  const authedFetch = (url: string, init: RequestInit = {}): Promise<Response> =>
    fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), cookie } });

  const bytes = fs.readFileSync(FIXTURE_PATH);
  const filename = `smoke-test-${Date.now()}.xlsx`;

  const upload = async (): Promise<UploadResponse> => {
    const form = new FormData();
    form.append(
      "file",
      new Blob([bytes], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      filename,
    );

    const res = await authedFetch(`${APP}/api/uploads`, { method: "POST", body: form });
    return (await res.json()) as UploadResponse;
  };

  console.log(`\n=== Uploading ${filename} (${bytes.length} bytes) ===`);
  let uploadBody = await upload();

  if (uploadBody.status === "duplicate_noop" && uploadBody.existingDatasetId) {
    // A prior run crashed before its own cleanup ran, leaving a completed
    // dataset with this exact fixture's hash. Clear it and try once more
    // rather than reporting a false pass/fail against stale data.
    console.log("  Found a leftover dataset from a previous run (same file hash); cleaning it up and retrying...");
    const staleSession = await authedFetch(`${APP}/api/datasets/${uploadBody.existingDatasetId}/session`);
    const staleSessionBody = (await staleSession.json()) as { sessionId?: string };

    if (staleSessionBody.sessionId) {
      await authedFetch(`${APP}/api/sessions/${staleSessionBody.sessionId}`, { method: "DELETE" });
    }

    uploadBody = await upload();
  }

  if (!uploadBody.jobId || !uploadBody.datasetId) {
    throw new Error(`Upload did not return a job/dataset: ${JSON.stringify(uploadBody)}`);
  }

  const { jobId, datasetId } = uploadBody as { jobId: string; datasetId: string };
  say("jobId", jobId);
  say("datasetId", datasetId);

  console.log("\n=== Waiting for ingestion to finish ===");
  const deadline = Date.now() + MAX_WAIT_MS;
  let finalStatus: string | null = null;
  let jobError: string | null = null;

  while (Date.now() < deadline) {
    const jobRes = await authedFetch(`${APP}/api/jobs/${jobId}`);
    const jobBody = (await jobRes.json()) as { status: string; error: string | null };
    say("job status", jobBody.status);

    if (jobBody.status === "completed" || jobBody.status === "failed") {
      finalStatus = jobBody.status;
      jobError = jobBody.error;
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  if (finalStatus !== "completed") {
    throw new Error(
      `Job never completed (last status: ${finalStatus ?? "still running after timeout"}, error: ${jobError ?? "none"}).`,
    );
  }

  let sessionIdToCleanUp: string | null = null;

  try {
    console.log("\n=== Verifying dataset record ===");
    const datasetRes = await authedFetch(`${APP}/api/datasets/${datasetId}`);
    const dataset = (await datasetRes.json()) as { status: string; totalRows: number };
    say("dataset status", dataset.status);
    say("dataset totalRows", dataset.totalRows);
    check("dataset status is ready", dataset.status === "ready", dataset.status);
    check("dataset totalRows > 0 (was stuck at 0 before today's fix)", dataset.totalRows > 0, String(dataset.totalRows));

    console.log("\n=== Verifying stored data (the 'Could not load data' bug) ===");
    const dataRes = await authedFetch(`${APP}/api/datasets/${datasetId}/data`);
    const dataBody = (await dataRes.json()) as {
      availableTables?: { tableName: string; tableRole: string; rowCount: number }[];
    };
    const availableTables = dataBody.availableTables ?? [];
    say("availableTables", availableTables.map((t) => `${t.tableName} (${t.rowCount} rows)`));
    check(
      "every sheet has stored rows, not zero",
      availableTables.length > 0 && availableTables.every((t) => t.rowCount > 0),
      JSON.stringify(availableTables),
    );

    const sumOfTableRows = availableTables.reduce((sum, t) => sum + t.rowCount, 0);
    check(
      "dataset.totalRows matches the sum of every table's row count",
      dataset.totalRows === sumOfTableRows,
      `totalRows=${dataset.totalRows} sum=${sumOfTableRows}`,
    );

    console.log("\n=== Verifying the wrapping session exists (the 'No session wraps this dataset yet' bug) ===");
    const sessionLookupRes = await authedFetch(`${APP}/api/datasets/${datasetId}/session`);
    const sessionLookupBody = (await sessionLookupRes.json()) as { sessionId?: string; error?: string };
    check(
      "a session wraps this dataset",
      sessionLookupRes.ok && Boolean(sessionLookupBody.sessionId),
      JSON.stringify(sessionLookupBody),
    );
    sessionIdToCleanUp = sessionLookupBody.sessionId ?? null;

    console.log("\n=== Verifying config: one tab per sheet, no cross-sheet mixing ===");
    const configRes = await authedFetch(`${APP}/api/datasets/${datasetId}/config`);
    const configBody = (await configRes.json()) as {
      config: {
        tabs: {
          tabId: string;
          tabName: string;
          widgets: { widgetId: string; sourceTable: string; aggregation: string; fields: string[] }[];
        }[];
      };
      insights: { insightId: string; relatedTables: string[] }[];
    };
    const tabs = configBody.config?.tabs ?? [];
    const insights = configBody.insights ?? [];
    say("tabs", tabs.map((t) => t.tabName));

    const isOverviewTab = (tab: { tabId: string; tabName: string }): boolean =>
      tab.tabId === "executive_overview" || /overview/i.test(tab.tabName);

    const seenTables = new Set<string>();
    let anyTabMixed = false;

    for (const tab of tabs) {
      if (isOverviewTab(tab)) continue;
      const tablesInTab = new Set(tab.widgets.map((w) => w.sourceTable));
      if (tablesInTab.size > 1) {
        anyTabMixed = true;
        console.error(`  tab "${tab.tabName}" mixes widgets from: ${Array.from(tablesInTab).join(", ")}`);
      }
      for (const t of tablesInTab) seenTables.add(t);
    }

    check("no non-overview tab mixes widgets from multiple sheets", !anyTabMixed);

    const availableTableNames = new Set(availableTables.map((t) => t.tableName));
    const missingOwnTab = Array.from(availableTableNames).filter((name) => !seenTables.has(name));
    check(
      "every parsed sheet has its own dedicated tab",
      missingOwnTab.length === 0,
      `missing: ${missingOwnTab.join(", ")}`,
    );

    console.log("\n=== Verifying widget aggregations against real column types ===");
    const tablesNeedingTypes = new Set(
      tabs
        .flatMap((t) => t.widgets)
        .filter((w) => w.aggregation === "sum" || w.aggregation === "avg")
        .map((w) => w.sourceTable),
    );
    const columnTypeByTable = new Map<string, Map<string, string>>();

    for (const tableName of tablesNeedingTypes) {
      const res = await authedFetch(
        `${APP}/api/datasets/${datasetId}/data?table=${encodeURIComponent(tableName)}&limit=1`,
      );
      const body = (await res.json()) as { columns: { name: string; inferredType: string }[] };
      columnTypeByTable.set(tableName, new Map(body.columns.map((c) => [c.name, c.inferredType])));
    }

    let anyBadAggregation = false;

    for (const tab of tabs) {
      for (const widget of tab.widgets) {
        if (widget.aggregation !== "sum" && widget.aggregation !== "avg") continue;
        const types = columnTypeByTable.get(widget.sourceTable);
        if (!types) continue;

        const hasNumeric = widget.fields.some((f) => types.get(f) === "numeric");

        if (!hasNumeric) {
          anyBadAggregation = true;
          console.error(
            `  widget "${widget.widgetId}" in tab "${tab.tabName}" applies "${widget.aggregation}" to non-numeric field(s) ${widget.fields.join(",")} in "${widget.sourceTable}"`,
          );
        }
      }
    }

    check("no widget sums/averages a non-numeric field", !anyBadAggregation);

    console.log("\n=== Verifying insights carry a valid relatedTables (the 'same insight on every tab' bug) ===");
    const allInsightsValid = insights.every((insight) => Array.isArray(insight.relatedTables));
    check("every insight has a relatedTables array", allInsightsValid);

    console.log("\n=== Verifying chat answers a real question ===");
    if (sessionLookupBody.sessionId) {
      const chatRes = await authedFetch(`${APP}/api/sessions/${sessionLookupBody.sessionId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "How many total records are in this dataset?" }),
      });
      const chatBody = (await chatRes.json()) as { directAnswer?: string; metrics?: unknown[]; error?: string };
      check(
        "chat returns a non-empty directAnswer, not an error",
        chatRes.ok && typeof chatBody.directAnswer === "string" && chatBody.directAnswer.length > 0,
        JSON.stringify(chatBody).slice(0, 300),
      );
    } else {
      say("chat probe", "skipped: no session to chat against");
    }
  } finally {
    if (sessionIdToCleanUp) {
      console.log("\n=== Cleaning up ===");
      const deleteRes = await authedFetch(`${APP}/api/sessions/${sessionIdToCleanUp}`, { method: "DELETE" });
      say("cleanup delete status", deleteRes.status);
    }
  }

  console.log("\n=== SUMMARY ===");
  say("failures", failures.length === 0 ? "none" : failures);
  console.log(`\nINGESTION SMOKE TEST: ${failures.length === 0 ? "PASS" : "FAIL"}`);
  process.exit(failures.length === 0 ? 0 : 1);
};

void main().catch((error: unknown) => {
  console.error("INGESTION SMOKE TEST ERROR:", error);
  process.exit(1);
});
