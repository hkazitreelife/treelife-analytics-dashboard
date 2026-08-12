/**
 * Phase 2 acceptance run against project_requirement.md Section 27.
 * Drives the real HTTP upload route so the whole pipeline is exercised:
 * hash check, File creation, Job creation, queue, worker pickup.
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
const EXPECTED_TABLES = [
  "README",
  "Constants",
  "Bands",
  "Onboarding",
  "Pipeline",
  "Decisions",
];

const line = (label: string, value: unknown): void => {
  console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
};

const main = async (): Promise<void> => {
  const email = process.env.ADMIN_EMAIL!;
  const password = process.env.ADMIN_PASSWORD!;

  // 1. Log in through Payload's real auth endpoint.
  const login = await fetch(`${APP}/api/users/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!login.ok) {
    throw new Error(`Login failed: ${login.status} ${await login.text()}`);
  }

  const cookie = login.headers.getSetCookie().join("; ");

  console.log("=== CHECK 1: upload through the real route ===");

  const bytes = await readFile(FIXTURE);
  const form = new FormData();

  form.append(
    "file",
    new File(
      [new Uint8Array(bytes)],
      "treelife-fy27-demo-dataset-v2.xlsx",
      {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    ),
    "treelife-fy27-demo-dataset-v2.xlsx",
  );

  const upload = await fetch(`${APP}/api/uploads`, {
    method: "POST",
    headers: { cookie },
    body: form,
  });

  const uploadBody = (await upload.json()) as Record<string, unknown>;

  line("upload HTTP status", upload.status);
  line("upload body", uploadBody);

  if (upload.status !== 202) {
    throw new Error(
      `Expected 202 from /api/uploads, got ${upload.status}. Body: ${JSON.stringify(uploadBody)}`,
    );
  }

  const jobId = String(uploadBody.jobId);
  const datasetId = String(uploadBody.datasetId);

  console.log("\n=== CHECK 2: job completes, dataset ready ===");

  const deadline = Date.now() + 240_000;
  let jobStatus = "queued";
  let jobError: unknown = null;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const statusResponse = await fetch(`${APP}/api/jobs/${jobId}`, {
      headers: { cookie },
    });
    const statusBody = (await statusResponse.json()) as Record<string, unknown>;

    jobStatus = String(statusBody.status);
    jobError = statusBody.error;

    if (jobStatus === "completed" || jobStatus === "failed") {
      break;
    }
  }

  line("job status", jobStatus);
  line("job error", jobError);

  const payload = await getPayload({ config });

  const dataset = await payload.findByID({
    collection: "datasets",
    id: datasetId,
    depth: 0,
  });

  line("dataset status", dataset.status);
  line("dataset totalRows", dataset.totalRows);

  if (jobStatus !== "completed" || dataset.status !== "ready") {
    console.log("\nRESULT: FAILED before table inspection.");
    await payload.db.destroy?.();
    process.exit(1);
  }

  console.log("\n=== CHECK 3 and 4: tables present, row counts ===");

  const stored = dataset.data as {
    tables: {
      tableName: string;
      tableRole: string;
      headerRowIndex: number;
      rows: Record<string, unknown>[];
      columns: {
        name: string;
        inferredType: string;
        nullable: boolean;
        sampleValues: string[];
      }[];
    }[];
    relationships: unknown[];
  };

  line("stored top-level keys", Object.keys(stored));
  for (const table of stored.tables) {
    console.log(
      `  ${table.tableName}: headerRowIndex=${table.headerRowIndex}, dataRows=${table.rows.length}, role=${table.tableRole}`,
    );
    console.log(
      `     columns: ${JSON.stringify(table.columns.map((c) => c.name))}`,
    );
  }

  const found = stored.tables.map((t) => t.tableName);
  const missing = EXPECTED_TABLES.filter((name) => !found.includes(name));
  const unexpected = found.filter((name) => !EXPECTED_TABLES.includes(name));

  line("missing expected tables", missing);
  line("extra tables beyond expected", unexpected);

  console.log("\n=== CHECK 5: README tableRole ===");

  const readme = stored.tables.find((t) => t.tableName === "README");

  line("README tableRole", readme?.tableRole ?? "TABLE NOT FOUND");

  console.log("\n=== CHECK 6: type inference spot-check ===");

  for (const name of ["Bands", "Pipeline"]) {
    const table = stored.tables.find((t) => t.tableName === name);

    if (!table) {
      line(`${name}`, "TABLE NOT FOUND");
      continue;
    }

    console.log(`-- ${name} (role=${table.tableRole}) --`);

    for (const column of table.columns) {
      console.log(
        `   ${column.name} | ${column.inferredType} | nullable=${column.nullable} | samples=${JSON.stringify(column.sampleValues.slice(0, 3))}`,
      );
    }
  }

  line("relationships", stored.relationships);

  console.log("\n=== SUMMARY ===");
  line("datasetId", datasetId);
  line("jobId", jobId);
  line("tableCount", stored.tables.length);
  line(
    "rowCounts",
    Object.fromEntries(stored.tables.map((t) => [t.tableName, t.rows.length])),
  );

  await payload.db.destroy?.();
  process.exit(missing.length === 0 ? 0 : 1);
};

void main().catch((error: unknown) => {
  console.error("ACCEPTANCE RUN ERROR:", error);
  process.exit(1);
});
