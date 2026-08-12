import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  INGESTION_QUEUE_NAME,
  redisConnectionOptions,
  type IngestionJobData,
} from "@analytics/shared";
import { Queue, Worker } from "bullmq";
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
const anthropicApiKey = requireEnv("ANTHROPIC_API_KEY");

const { getPayload } = await import("payload");
const { default: config } = await import("@payload-config");
const { createGeminiClient } = await import("./services/gemini");
const { createClaudeConfigClient } = await import("./services/claudeConfig");
const { createDatasetLock } = await import("./services/datasetLock");
const { createDatasetEventPublisher } = await import("./services/events");
const { processIngestionJob } = await import("./processors/ingestion");

const payload = await getPayload({ config });
const gemini = createGeminiClient(geminiApiKey);
const claude = createClaudeConfigClient(anthropicApiKey);
const datasetLock = createDatasetLock(connection);
// Shares `connection`: publish is a normal command, not a dedicated
// subscriber-mode client the way SUBSCRIBE is, so no second connection.
const events = createDatasetEventPublisher(connection);

// Shares `connection` rather than opening a second Redis connection: BullMQ
// supports a Queue (producer) and a Worker (consumer) on the same client.
// Used only to requeue a job that lost a per-dataset lock race, with a delay.
const ingestionQueue = new Queue<IngestionJobData>(INGESTION_QUEUE_NAME, {
  connection,
});

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
    // parse must never overwrite a working dataset. lastError is denormalized
    // here so the dashboard can show the real technical reason instead of a
    // generic canned string, whether or not a previous good dataset survives.
    if (jobRecord.dataset !== null && jobRecord.dataset !== undefined) {
      await payload.update({
        collection: "datasets",
        id: jobRecord.dataset,
        data: { status: "failed", lastError: message },
      });

      await events.publish("dataset.updated", String(jobRecord.dataset), data.jobId);
    }

    await events.publish("job.updated", data.datasetId, data.jobId);
  } catch (updateError: unknown) {
    payload.logger.error({ err: updateError }, "Could not record job failure.");
  }
};

const worker = new Worker<IngestionJobData>(
  INGESTION_QUEUE_NAME,
  async (job) => {
    try {
      await processIngestionJob(job.data, {
        payload,
        gemini,
        claude,
        datasetLock,
        queue: ingestionQueue,
        events,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);

      await recordFailure(job.data, message);

      throw error;
    }
  },
  {
    connection,
    // One job at a time. This is process-level serialization; the per-dataset
    // Redis lock in services/datasetLock.ts is what actually protects against
    // two jobs writing to the same Dataset if concurrency is ever raised
    // above 1.
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
  await ingestionQueue.close();
  connection.disconnect();
  await payload.db.destroy?.();

  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
