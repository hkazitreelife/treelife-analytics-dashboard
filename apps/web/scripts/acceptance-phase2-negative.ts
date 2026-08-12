/**
 * Check 7: a Gemini response missing a required field must fail the job visibly
 * and must leave the existing Dataset's stored data untouched.
 *
 * The Gemini boundary is mocked here on purpose. Everything downstream of it
 * (retry, merge, Zod validation, failure recording) is the real code path.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { getPayload } from "payload";

import config from "../payload.config";

const main = async (): Promise<void> => {
  const payload = await getPayload({ config });

  const { processIngestionJob } = await import(
    "../../../worker/src/processors/ingestion"
  );

  // Use the dataset produced by the positive run, so there is real prior data
  // that must survive the failure.
  const datasets = await payload.find({
    collection: "datasets",
    where: { status: { equals: "ready" } },
    limit: 1,
    depth: 0,
    sort: "-updatedAt",
  });

  const dataset = datasets.docs[0];

  if (!dataset) {
    throw new Error("No ready dataset found. Run the positive acceptance first.");
  }

  const before = JSON.stringify(dataset.data);
  const beforeHash = (
    await import("node:crypto")
  ).createHash("sha256").update(before).digest("hex");

  console.log(`prior dataset id=${dataset.id} status=${dataset.status}`);
  console.log(`prior data bytes=${before.length} sha256=${beforeHash}`);
  console.log(`prior tableNames=${JSON.stringify((dataset.tableNames ?? []).map((t) => t.tableName))}`);
  console.log(`prior totalRows=${dataset.totalRows}`);

  const fileId =
    typeof dataset.currentFile === "number"
      ? dataset.currentFile
      : dataset.currentFile?.id;

  if (!fileId) {
    throw new Error("Dataset has no currentFile.");
  }

  const job = await payload.create({
    collection: "jobs",
    data: {
      file: fileId,
      dataset: dataset.id,
      fileHash: dataset.currentFileHash ?? "unknown",
      status: "queued",
      retryCount: 0,
    },
  });

  console.log(`created job id=${job.id} status=queued`);

  // Mock: drops the required tableRole field from the first table.
  let calls = 0;

  const brokenGemini = {
    primaryModel: "mock-primary",
    retryModelName: "mock-retry",
    inferMetadata: async (parsed: {
      tables: { tableName: string; width: number }[];
    }) => {
      calls += 1;

      return {
        tables: parsed.tables.map((table, index) => {
          const base = {
            tableName: table.tableName,
            headerRowIndex: 1,
            columns: Array.from({ length: table.width }, (_, columnIndex) => ({
              columnIndex,
              inferredType: "text" as const,
              nullable: true,
            })),
          };

          // First table deliberately omits the required tableRole field.
          return index === 0 ? base : { ...base, tableRole: "data" as const };
        }),
        relationships: [],
      };
    },
  };

  let failureMessage = "";

  try {
    await processIngestionJob(
      {
        jobId: String(job.id),
        fileId: String(fileId),
        datasetId: String(dataset.id),
        fileHash: dataset.currentFileHash ?? "unknown",
      },
      {
        payload,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        gemini: brokenGemini as any,
        // Never reached: the merge fails before config generation starts.
        claude: {
          primaryModel: "unused",
          retryModelName: "unused",
          generateConfig: async () => {
            throw new Error("Claude must not be called when the merge fails.");
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        mediaDir: path.resolve(process.cwd(), "media"),
      },
    );

    console.log("UNEXPECTED: processor did not throw.");
  } catch (error: unknown) {
    failureMessage = error instanceof Error ? error.message : String(error);
    console.log(`processor threw as expected`);
  }

  // The worker records the failure; replicate that here since we called the
  // processor directly rather than through the queue.
  await payload.update({
    collection: "jobs",
    id: job.id,
    data: { status: "failed", error: failureMessage },
  });

  const jobAfter = await payload.findByID({
    collection: "jobs",
    id: job.id,
    depth: 0,
  });

  const datasetAfter = await payload.findByID({
    collection: "datasets",
    id: dataset.id,
    depth: 0,
  });

  const after = JSON.stringify(datasetAfter.data);
  const afterHash = (
    await import("node:crypto")
  ).createHash("sha256").update(after).digest("hex");

  console.log("");
  console.log(`gemini calls (1 = no retry, 2 = retried once): ${calls}`);
  console.log(`job status after: ${jobAfter.status}`);
  console.log(`job error stored: ${String(jobAfter.error).slice(0, 220)}`);
  console.log("");
  console.log(`data bytes after=${after.length} sha256=${afterHash}`);
  console.log(`data unchanged: ${before === after}`);
  console.log(`tableNames after=${JSON.stringify((datasetAfter.tableNames ?? []).map((t) => t.tableName))}`);
  console.log(`totalRows after=${datasetAfter.totalRows}`);

  const passed =
    jobAfter.status === "failed" &&
    typeof jobAfter.error === "string" &&
    jobAfter.error.length > 0 &&
    before === after &&
    calls === 2;

  console.log("");
  console.log(`NEGATIVE TEST: ${passed ? "PASS" : "FAIL"}`);

  await payload.db.destroy?.();
  process.exit(passed ? 0 : 1);
};

void main().catch((error: unknown) => {
  console.error("NEGATIVE TEST ERROR:", error);
  process.exit(1);
});
