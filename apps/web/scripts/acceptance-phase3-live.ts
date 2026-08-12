/**
 * Phase 3 live acceptance. Uploads through the real HTTP route and lets the real
 * worker run both AI steps: Gemini for structure, Claude for config and
 * insights. Nothing is stubbed.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { getPayload } from "payload";

import config from "../payload.config";

const APP = process.env.PUBLIC_APP_URL ?? "http://localhost:3000";
const FIXTURE = path.resolve(
  process.cwd(),
  "../../treelife-fy27-demo-dataset-v2.xlsx",
);

const say = (label: string, value: unknown): void => {
  console.log(
    `${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
};

const main = async (): Promise<void> => {
  const email = process.env.ADMIN_EMAIL!;
  const password = process.env.ADMIN_PASSWORD!;

  const login = await fetch(`${APP}/api/users/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!login.ok) {
    throw new Error(`Login failed: ${login.status}`);
  }

  const cookie = login.headers.getSetCookie().join("; ");

  console.log("=== upload through the real route ===");

  const bytes = await readFile(FIXTURE);
  const form = new FormData();

  form.append(
    "file",
    new File([new Uint8Array(bytes)], "treelife-fy27-demo-dataset-v2.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    "treelife-fy27-demo-dataset-v2.xlsx",
  );

  const upload = await fetch(`${APP}/api/uploads`, {
    method: "POST",
    headers: { cookie },
    body: form,
  });

  const uploadBody = (await upload.json()) as Record<string, unknown>;

  say("upload status", upload.status);
  say("upload body", uploadBody);

  if (upload.status !== 202) {
    throw new Error(`Expected 202, got ${upload.status}`);
  }

  const jobId = String(uploadBody.jobId);
  const datasetId = String(uploadBody.datasetId);

  console.log("\n=== CHECK 1: job completes only after a Config exists ===");

  const payload = await getPayload({ config });
  const deadline = Date.now() + 300_000;

  let jobStatus = "queued";
  let jobError: unknown = null;
  let configExistedWhenDatasetReady: boolean | null = null;
  let sawDatasetReadyBeforeCompletion = false;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const statusResponse = await fetch(`${APP}/api/jobs/${jobId}`, {
      headers: { cookie },
    });
    const statusBody = (await statusResponse.json()) as Record<string, unknown>;

    jobStatus = String(statusBody.status);
    jobError = statusBody.error;

    // Sample the intermediate state: if the dataset is ready while the job is
    // still open, that is the ordering this check is about.
    if (jobStatus !== "completed" && jobStatus !== "failed") {
      const ds = await payload.findByID({
        collection: "datasets",
        id: datasetId,
        depth: 0,
      });

      if (ds.status === "ready") {
        sawDatasetReadyBeforeCompletion = true;

        const mid = await payload.count({
          collection: "configs",
          where: { dataset: { equals: Number(datasetId) } },
        });

        configExistedWhenDatasetReady = mid.totalDocs > 0;
      }
    }

    if (jobStatus === "completed" || jobStatus === "failed") {
      break;
    }
  }

  say("job status", jobStatus);
  say("job error", jobError);

  const dataset = await payload.findByID({
    collection: "datasets",
    id: datasetId,
    depth: 0,
  });

  say("dataset status", dataset.status);
  say("dataset totalRows", dataset.totalRows);

  const configs = await payload.find({
    collection: "configs",
    where: { dataset: { equals: Number(datasetId) } },
    limit: 1,
    depth: 0,
    sort: "-version",
  });

  const stored = configs.docs[0];

  say("config exists at completion", stored !== undefined);
  say("observed dataset ready while job still open", sawDatasetReadyBeforeCompletion);
  say("config already existed at that moment", configExistedWhenDatasetReady);

  if (jobStatus !== "completed" || !stored) {
    console.log("\nRESULT: FAILED before config inspection.");
    await payload.db.destroy?.();
    process.exit(1);
  }

  const job = await payload.findByID({
    collection: "jobs",
    id: jobId,
    depth: 0,
  });

  const configCreated = new Date(stored.createdAt).getTime();
  const jobCompleted = job.completedAt
    ? new Date(job.completedAt).getTime()
    : 0;

  say("config createdAt", stored.createdAt);
  say("job completedAt", job.completedAt);
  say("config written before job completed", configCreated <= jobCompleted);
  say("config generatedBy", stored.generatedBy);
  say("config version", stored.version);

  console.log("\n=== CHECK 2: config references only real names ===");

  const { findUnknownReferences, buildDatasetMetadata } = await import(
    "../../../worker/src/services/claudeConfig"
  );

  const datasetData = dataset.data as {
    tables: {
      tableName: string;
      tableRole: string;
      columns: { name: string; inferredType: string }[];
      rows: Record<string, unknown>[];
    }[];
    relationships: unknown[];
  };

  const dashboardConfig = stored.config as {
    title: string;
    tabs: {
      tabName: string;
      widgets: {
        widgetId: string;
        type: string;
        title: string;
        sourceTable: string;
        fields: string[];
        aggregation: string;
      }[];
    }[];
    insights: { title: string; body: string; severity: string }[];
  };

  const problems = findUnknownReferences(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dashboardConfig as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    datasetData.tables as any,
  );

  say("config title", dashboardConfig.title);
  say("tab count", dashboardConfig.tabs.length);

  for (const tab of dashboardConfig.tabs) {
    console.log(`  tab "${tab.tabName}" (${tab.widgets.length} widgets)`);

    for (const widget of tab.widgets) {
      console.log(
        `     ${widget.type} "${widget.title}" <- ${widget.sourceTable}.${JSON.stringify(widget.fields)} agg=${widget.aggregation}`,
      );
    }
  }

  say("unknown table/column references", problems);

  console.log("\n=== CHECK 3: insights state real, traceable numbers ===");

  const metadata = buildDatasetMetadata(
    datasetId,
    dataset.name,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    datasetData.tables as any,
    datasetData.relationships,
  );

  // Every number the data can legitimately support.
  const truths = new Set<string>();

  for (const table of metadata.tables) {
    truths.add(String(table.rowCount));

    for (const aggregate of table.numericAggregates) {
      for (const value of [
        aggregate.sum,
        aggregate.avg,
        aggregate.min,
        aggregate.max,
        aggregate.nonNullCount,
      ]) {
        truths.add(String(value));
        truths.add(String(Number(value.toFixed(2))));
        truths.add(String(Math.round(value)));
      }
    }

    for (const column of table.columns) {
      truths.add(String(column.emptyCount));
      for (const sample of column.sampleValues) {
        truths.add(sample);
      }
    }
  }

  let traceableInsights = 0;

  for (const insight of dashboardConfig.insights) {
    const numbers = `${insight.title} ${insight.body}`.match(
      /\d+(?:\.\d+)?/g,
    ) ?? [];
    const matched = numbers.filter((n) => truths.has(n));
    const isTraceable = matched.length > 0;

    if (isTraceable) {
      traceableInsights += 1;
    }

    console.log(
      `  [${insight.severity}] ${insight.title}\n     ${insight.body}\n     numbers=${JSON.stringify(numbers.slice(0, 8))} traceable=${JSON.stringify(matched.slice(0, 8))}`,
    );
  }

  say("insight count", dashboardConfig.insights.length);
  say("insights with a traceable number", traceableInsights);

  console.log("\n=== CHECK 4: GET /api/datasets/:id/config ===");

  const endpoint = await fetch(`${APP}/api/datasets/${datasetId}/config`, {
    headers: { cookie },
  });
  const endpointBody = (await endpoint.json()) as Record<string, unknown>;

  say("HTTP status", endpoint.status);
  say("version", endpointBody.version);
  say("generatedBy", endpointBody.generatedBy);
  say("config title", (endpointBody.config as { title?: string })?.title);
  say("insights returned", (endpointBody.insights as unknown[] | undefined)?.length);
  say(
    "matches stored record",
    JSON.stringify(endpointBody.config) === JSON.stringify(stored.config),
  );

  const passed =
    jobStatus === "completed" &&
    dataset.status === "ready" &&
    stored !== undefined &&
    configCreated <= jobCompleted &&
    problems.length === 0 &&
    traceableInsights > 0 &&
    endpoint.status === 200 &&
    JSON.stringify(endpointBody.config) === JSON.stringify(stored.config);

  console.log(`\nLIVE PHASE 3: ${passed ? "PASS" : "FAIL"}`);

  await payload.db.destroy?.();
  process.exit(passed ? 0 : 1);
};

void main().catch((error: unknown) => {
  console.error("LIVE PHASE 3 ERROR:", error);
  process.exit(1);
});
