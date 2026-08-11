import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  INGESTION_QUEUE_NAME,
  redisConnectionOptions,
  type IngestionJobData,
} from "@analytics/shared";
import { Worker, type Job } from "bullmq";
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

const { getPayload } = await import("payload");
const { default: config } = await import("@payload-config");

const payload = await getPayload({ config });

const process_ = async (job: Job<IngestionJobData>): Promise<void> => {
  const { jobId } = job.data;

  await payload.update({
    collection: "jobs",
    id: jobId,
    data: { status: "processing" },
  });

  // Placeholder for the ingestion pipeline. Gemini extraction, validation and
  // Claude config generation are added in later phases.
  await new Promise((resolve) => setTimeout(resolve, 2000));

  await payload.update({
    collection: "jobs",
    id: jobId,
    data: {
      status: "completed",
      completedAt: new Date().toISOString(),
    },
  });

  const jobRecord = await payload.findByID({
    collection: "jobs",
    id: jobId,
    depth: 0,
  });

  if (jobRecord.dataset !== null && jobRecord.dataset !== undefined) {
    await payload.update({
      collection: "datasets",
      id: jobRecord.dataset as number | string,
      data: { status: "ready" },
    });
  }
};

const worker = new Worker<IngestionJobData>(
  INGESTION_QUEUE_NAME,
  async (job) => {
    try {
      await process_(job);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);

      // A failed job must stay visible and must never leave a dataset looking
      // complete. The previous dataset data is left untouched.
      try {
        await payload.update({
          collection: "jobs",
          id: job.data.jobId,
          data: { status: "failed", error: message },
        });

        const jobRecord = await payload.findByID({
          collection: "jobs",
          id: job.data.jobId,
          depth: 0,
        });

        if (jobRecord.dataset !== null && jobRecord.dataset !== undefined) {
          await payload.update({
            collection: "datasets",
            id: jobRecord.dataset as number | string,
            data: { status: "failed" },
          });
        }
      } catch (updateError: unknown) {
        payload.logger.error(
          { err: updateError },
          "Could not record job failure.",
        );
      }

      throw error;
    }
  },
  {
    connection,
    // One job at a time keeps two uploads for the same dataset from racing.
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
