/**
 * Phase 3 acceptance. ANTHROPIC_API_KEY is empty, so the Claude boundary is
 * stubbed. Everything downstream of that boundary is the real code path:
 * schema validation, reference checking, retry routing, the Configs write, job
 * ordering, and the HTTP config endpoint.
 *
 * What this cannot prove is the quality of a real Claude response. That is
 * reported as untested, not asserted.
 */
import path from "node:path";

import { getPayload } from "payload";

import config from "../payload.config";

const APP = process.env.PUBLIC_APP_URL ?? "http://localhost:3000";

const say = (label: string, value: unknown): void => {
  console.log(
    `${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
};

type StoredTable = {
  tableName: string;
  tableRole: string;
  headerRowIndex: number;
  columns: { name: string; inferredType: string; nullable: boolean }[];
  rows: Record<string, unknown>[];
};

/** Builds a valid config that references only names present in the dataset. */
const buildValidConfig = (datasetId: string, tables: StoredTable[]) => {
  const dataTables = tables.filter((t) => t.rows.length > 0);
  const first = dataTables[0]!;
  const numeric = first.columns.find((c) => c.inferredType === "numeric");
  const categorical =
    first.columns.find((c) => c.inferredType === "categorical") ??
    first.columns[0]!;

  return {
    datasetId,
    title: "Stubbed dashboard",
    tabs: [
      {
        tabId: "overview",
        tabName: "Overview",
        widgets: [
          {
            widgetId: "kpi-1",
            type: "kpi_card" as const,
            title: `Total ${numeric?.name ?? categorical.name}`,
            sourceTable: first.tableName,
            fields: [numeric?.name ?? categorical.name],
            aggregation: numeric ? ("sum" as const) : ("count" as const),
            position: { row: 0, col: 0, w: 3, h: 2 },
          },
          {
            widgetId: "table-1",
            type: "table" as const,
            title: first.tableName,
            sourceTable: first.tableName,
            fields: first.columns.slice(0, 4).map((c) => c.name),
            aggregation: "none" as const,
            position: { row: 2, col: 0, w: 12, h: 6 },
          },
        ],
      },
    ],
    insights: [
      {
        insightId: "i-1",
        title: "Row count",
        body: `${first.tableName} holds ${first.rows.length} rows.`,
        severity: "info" as const,
        relatedTables: [first.tableName],
      },
    ],
  };
};

const main = async (): Promise<void> => {
  const payload = await getPayload({ config });
  const { processIngestionJob } = await import(
    "../../../worker/src/processors/ingestion"
  );
  const { findUnknownReferences } = await import(
    "../../../worker/src/services/claudeConfig"
  );

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

  const datasets = await payload.find({
    collection: "datasets",
    where: { status: { equals: "ready" } },
    limit: 1,
    depth: 0,
    sort: "-updatedAt",
  });

  const dataset = datasets.docs[0];

  if (!dataset) {
    throw new Error("No ready dataset. Run the Phase 2 acceptance first.");
  }

  const stored = dataset.data as { tables: StoredTable[] };
  const fileId =
    typeof dataset.currentFile === "number"
      ? dataset.currentFile
      : dataset.currentFile?.id;

  if (!fileId) {
    throw new Error("Dataset has no currentFile.");
  }

  const mediaDir = path.resolve(process.cwd(), "media");

  // Replays the metadata already stored for this dataset, so re-running the
  // pipeline reproduces the identical dataset rather than reparsing it with a
  // different header guess. That keeps "dataset unchanged" a meaningful
  // assertion in the failure scenario below.
  const storedByName = new Map(stored.tables.map((t) => [t.tableName, t]));

  const workingGemini = {
    primaryModel: "stub",
    retryModelName: "stub",
    inferMetadata: async (parsed: {
      tables: { tableName: string; width: number }[];
    }) => ({
      tables: parsed.tables.map((t) => {
        const original = storedByName.get(t.tableName);

        if (!original) {
          throw new Error(`No stored metadata for table "${t.tableName}".`);
        }

        return {
          tableName: t.tableName,
          tableRole: original.tableRole as "data",
          headerRowIndex: original.headerRowIndex,
          columns: Array.from({ length: t.width }, (_, columnIndex) => ({
            columnIndex,
            inferredType: (original.columns[columnIndex]?.inferredType ??
              "text") as "text",
            nullable: original.columns[columnIndex]?.nullable ?? true,
          })),
        };
      }),
      relationships: [],
    }),
  };

  const newJob = async () =>
    payload.create({
      collection: "jobs",
      data: {
        file: fileId,
        dataset: dataset.id,
        fileHash: dataset.currentFileHash ?? "unknown",
        status: "queued",
        retryCount: 0,
      },
    });

  const jobData = (jobId: number | string) => ({
    jobId: String(jobId),
    fileId: String(fileId),
    datasetId: String(dataset.id),
    fileHash: dataset.currentFileHash ?? "unknown",
  });

  // ---------------------------------------------------------------- scenario 1
  console.log("=== CHECK 1 and 2: job completes only after a Config exists ===");

  const configsBefore = await payload.count({
    collection: "configs",
    where: { dataset: { equals: dataset.id } },
  });

  say("configs before run", configsBefore.totalDocs);

  let sawConfigAtCompletion = false;
  let jobStatusWhenConfigWritten = "";

  const job1 = await newJob();

  const validClaude = {
    primaryModel: "stub-primary",
    retryModelName: "stub-retry",
    generateConfig: async () => {
      // Observe the job's status at the moment config generation runs. It must
      // not already be completed.
      const current = await payload.findByID({
        collection: "jobs",
        id: job1.id,
        depth: 0,
      });

      jobStatusWhenConfigWritten = current.status;

      return buildValidConfig(String(dataset.id), stored.tables);
    },
  };

  await processIngestionJob(jobData(job1.id), {
    payload,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gemini: workingGemini as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    claude: validClaude as any,
    mediaDir,
  });

  const job1After = await payload.findByID({
    collection: "jobs",
    id: job1.id,
    depth: 0,
  });

  const configsAfter = await payload.find({
    collection: "configs",
    where: { dataset: { equals: dataset.id } },
    limit: 1,
    depth: 0,
    sort: "-version",
  });

  const writtenConfig = configsAfter.docs[0];

  sawConfigAtCompletion =
    job1After.status === "completed" && writtenConfig !== undefined;

  say("job status during config generation", jobStatusWhenConfigWritten);
  say("job status after run", job1After.status);
  say("config record exists", writtenConfig !== undefined);
  say("config generatedBy", writtenConfig?.generatedBy);
  say("config version", writtenConfig?.version);

  const refProblems = writtenConfig
    ? findUnknownReferences(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        writtenConfig.config as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        stored.tables as any,
      )
    : ["no config"];

  say("unknown table/column references", refProblems);

  // ---------------------------------------------------------------- scenario 2
  console.log("\n=== CHECK 4: GET /api/datasets/:id/config ===");

  const configResponse = await fetch(
    `${APP}/api/datasets/${dataset.id}/config`,
    { headers: { cookie } },
  );
  const configBody = (await configResponse.json()) as Record<string, unknown>;

  say("HTTP status", configResponse.status);
  say("returned version", configBody.version);
  say("returned generatedBy", configBody.generatedBy);
  say("returned config title", (configBody.config as { title?: string })?.title);
  say("insight count", (configBody.insights as unknown[] | undefined)?.length);

  // ---------------------------------------------------------------- scenario 3
  console.log(
    "\n=== CHECK 5: Claude returns a config missing a required field ===",
  );

  // Baseline taken immediately before this scenario, not at script start:
  // scenario 1 legitimately rewrote the dataset, and the question here is only
  // whether a config failure leaves the dataset alone.
  const datasetBefore = await payload.findByID({
    collection: "datasets",
    id: dataset.id,
    depth: 0,
  });

  const dataBefore = JSON.stringify(datasetBefore.data);
  const statusBefore = datasetBefore.status;
  const versionBefore = writtenConfig?.version ?? 0;

  let claudeCalls = 0;

  const brokenClaude = {
    primaryModel: "stub-primary",
    retryModelName: "stub-retry",
    generateConfig: async () => {
      claudeCalls += 1;

      const valid = buildValidConfig(String(dataset.id), stored.tables);
      // Drop a required field: widget.aggregation.
      const { aggregation: _dropped, ...widgetWithoutAggregation } =
        valid.tabs[0]!.widgets[0]!;

      return {
        ...valid,
        tabs: [
          {
            ...valid.tabs[0]!,
            widgets: [widgetWithoutAggregation, valid.tabs[0]!.widgets[1]!],
          },
        ],
      };
    },
  };

  const job2 = await newJob();
  let failureMessage = "";

  try {
    await processIngestionJob(jobData(job2.id), {
      payload,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      gemini: workingGemini as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      claude: brokenClaude as any,
      mediaDir,
    });

    console.log("UNEXPECTED: processor did not throw.");
  } catch (error: unknown) {
    failureMessage = error instanceof Error ? error.message : String(error);
  }

  await payload.update({
    collection: "jobs",
    id: job2.id,
    data: { status: "failed", error: failureMessage },
  });

  const job2After = await payload.findByID({
    collection: "jobs",
    id: job2.id,
    depth: 0,
  });

  const datasetAfter = await payload.findByID({
    collection: "datasets",
    id: dataset.id,
    depth: 0,
  });

  const configsAfterFailure = await payload.find({
    collection: "configs",
    where: { dataset: { equals: dataset.id } },
    limit: 1,
    depth: 0,
    sort: "-version",
  });

  say("claude calls (2 = retried once)", claudeCalls);
  say("job status", job2After.status);
  say("job error stored", String(job2After.error).slice(0, 200));
  say("dataset status unchanged", datasetAfter.status === statusBefore);
  say("dataset data unchanged", JSON.stringify(datasetAfter.data) === dataBefore);
  say("dataset totalRows", datasetAfter.totalRows);
  say(
    "no new config version written",
    (configsAfterFailure.docs[0]?.version ?? 0) === versionBefore,
  );

  const passed =
    sawConfigAtCompletion &&
    jobStatusWhenConfigWritten !== "completed" &&
    refProblems.length === 0 &&
    configResponse.status === 200 &&
    claudeCalls === 2 &&
    job2After.status === "failed" &&
    String(job2After.error).length > 0 &&
    JSON.stringify(datasetAfter.data) === dataBefore &&
    (configsAfterFailure.docs[0]?.version ?? 0) === versionBefore;

  console.log(`\nPHASE 3 HARNESS: ${passed ? "PASS" : "FAIL"}`);

  await payload.db.destroy?.();
  process.exit(passed ? 0 : 1);
};

void main().catch((error: unknown) => {
  console.error("PHASE 3 HARNESS ERROR:", error);
  process.exit(1);
});
