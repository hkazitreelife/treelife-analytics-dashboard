import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  INGESTION_QUEUE_NAME,
  redisConnectionOptions,
  type IngestionJobData,
} from "@analytics/shared";
import { Worker } from "bullmq";
import dotenv from "dotenv";
import { Redis } from "ioredis";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// The worker shares the web app's environment file. It is loaded before the
// Payload config is imported, because that config reads env at module scope.
dotenv.config({
  path: path.resolve(dirname, "../../apps/web/.env.local"),
  quiet: true,
});

const requireEnv = (name: string): string => {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. See apps/web/.env.local.`,
    );
  }

  return value;
};

// bullmq 6 treats ioredis as an optional peer and cannot require it lazily from
// a native ESM context, so the client is constructed here and passed in.
const connection = new Redis(requireEnv("REDIS_URL"), redisConnectionOptions);
const geminiApiKey = requireEnv("GEMINI_API_KEY");

const { getPayload } = await import("payload");
const { default: config } = await import("@payload-config");
const { createGeminiClient } = await import("./services/gemini");
const { processIngestionJob } = await import("./processors/ingestion");

const payload = await getPayload({ config });
const gemini = createGeminiClient(geminiApiKey);

const recordFailure = async (
  data: IngestionJobData,
  message: string,
): Promise<void> => {
  try {
    await payload.update({
      collection: "jobs",
      id: data.jobId,
      data: { status: "failed", error: message },
    });

    const jobRecord = await payload.findByID({
      collection: "jobs",
      id: data.jobId,
      depth: 0,
    });

    // The Dataset is marked failed so nothing presents as complete, but its
    // data, tableNames and totalRows are deliberately left untouched. A failed
    // parse must never overwrite a working dataset.
    if (jobRecord.dataset !== null && jobRecord.dataset !== undefined) {
      await payload.update({
        collection: "datasets",
        id: jobRecord.dataset,
        data: { status: "failed" },
      });
    }
  } catch (updateError: unknown) {
    payload.logger.error({ err: updateError }, "Could not record job failure.");
  }
};

const worker = new Worker<IngestionJobData>(
  INGESTION_QUEUE_NAME,
  async (job) => {
    try {
      await processIngestionJob(job.data, { payload, gemini });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);

      await recordFailure(job.data, message);

      throw error;
    }
  },
  {
    connection,
    // One job at a time. Note: this is process-level serialization, not a
    // per-dataset lock. See report notes for Phase 4.
    concurrency: 1,
  },
);

worker.on("completed", (job) => {
  payload.logger.info(`Job ${job.data.jobId} completed.`);
});

worker.on("failed", (job, error) => {
  payload.logger.error(
    { err: error },
    `Job ${job?.data.jobId ?? "unknown"} failed.`,
  );
});

payload.logger.info(
  `Worker listening on queue "${INGESTION_QUEUE_NAME}". Press Ctrl+C to stop.`,
);

const shutdown = async (signal: string): Promise<void> => {
  payload.logger.info(`Received ${signal}. Shutting down worker.`);

  await worker.close();
  connection.disconnect();
  await payload.db.destroy?.();

  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
