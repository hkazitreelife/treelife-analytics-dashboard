import "dotenv/config";
import { Worker, Queue, type Job } from "bullmq";
import { Redis, type RedisOptions } from "ioredis";
import { getPayload, type Payload } from "payload";

import {
  INGESTION_QUEUE_NAME,
  DOCUMENT_INGESTION_QUEUE_NAME,
  redisConnectionOptions,
  type IngestionJobData,
  type DocumentIngestionJobData,
} from "@analytics/shared";

import { createGeminiClient } from "./services/gemini";
import { createClaudeConfigClient } from "./services/claudeConfig";
import { createGeminiDocumentClient } from "./services/geminiDocument";
import { createClaudeDocumentSummaryClient } from "./services/claudeDocumentSummary";
import { createDatasetLock } from "./services/datasetLock";
import { createDatasetEventPublisher } from "./services/events";
import { processIngestionJob } from "./processors/ingestion";
import { processDocumentIngestionJob } from "./processors/documentIngestion";

/**
 * This file previously ran its own separate, much simpler pipeline
 * (raw SQL against tables/columns that don't match what Payload actually
 * generates -- e.g. UPDATE datasets SET metadata = ... where the Datasets
 * collection has no "metadata" field at all, and INSERT ... ON CONFLICT
 * (dataset_id) where there is no unique constraint enabling that, since
 * multiple config versions per dataset is the whole point of the version
 * column). Every job that reached its final persistence step failed there.
 * It also had no column-type inference at all and the same missing-
 * OpenRouter-branch bug fixed elsewhere in this pass.
 *
 * processors/ingestion.ts and processors/documentIngestion.ts are the
 * real, complete, Payload-integrated, Zod-validated pipeline this project
 * documents everywhere else (worker/src/verify-15-1.ts already exercises
 * them successfully against live Payload data) -- this file's only job
 * now is to bootstrap Payload and the AI clients, then hand every queued
 * job to them.
 */

const requireEnv = (name: string): string => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }

  return value;
};

const buildRedisConnection = (): Redis => {
  const url = requireEnv("REDIS_URL");
  const isTls = url.startsWith("rediss://");

  const options: RedisOptions = {
    ...redisConnectionOptions,
    ...(isTls ? { tls: { rejectUnauthorized: false } } : {}),
    enableReadyCheck: false,
    retryStrategy: (times: number) => Math.min(times * 200, 2000),
  };

  return new Redis(url, options);
};

const markJobFailed = async (
  payload: Payload,
  jobId: string,
  error: unknown,
): Promise<void> => {
  const message = error instanceof Error ? error.message : String(error);

  try {
    await payload.update({
      collection: "jobs",
      id: jobId,
      data: { status: "failed", error: message },
    });
  } catch (updateErr: unknown) {
    console.error(`[Worker] Could not mark job ${jobId} as failed:`, updateErr);
  }
};

export const startWorker = async (): Promise<void> => {
  console.log("==========================================");
  console.log("🚀 Starting Treelife AI Background Worker");
  console.log("==========================================");

  // payload.config.ts lives in apps/web; Dockerfile.worker copies it and
  // its collections alongside this worker's own source specifically so
  // Payload can be constructed here the same way the web process does --
  // confirmed working by worker/src/verify-15-1.ts.
  const { default: payloadConfig } = await import("../../apps/web/payload.config" as any);
  const payload = await getPayload({ config: payloadConfig });

  const redisConnection = buildRedisConnection();

  redisConnection.on("connect", () => {
    console.log("[Redis] 🟢 Connected to Redis successfully.");
  });
  redisConnection.on("error", (err) => {
    console.error("[Redis] 🔴 Redis connection error:", err.message);
  });

  const geminiApiKey = requireEnv("GEMINI_API_KEY");
  const anthropicApiKey = requireEnv("ANTHROPIC_API_KEY");

  const gemini = createGeminiClient(geminiApiKey);
  const claude = createClaudeConfigClient(anthropicApiKey);
  const geminiDocument = createGeminiDocumentClient(geminiApiKey);
  const claudeSummary = createClaudeDocumentSummaryClient(anthropicApiKey);

  // All four share this one connection deliberately -- same reasoning as
  // datasetLock.ts's and events.ts's own doc comments: reuse the worker's
  // existing connection, never open a second one per feature.
  const datasetLock = createDatasetLock(redisConnection);
  const events = createDatasetEventPublisher(redisConnection);
  const ingestionQueue = new Queue<IngestionJobData>(INGESTION_QUEUE_NAME, {
    connection: redisConnection,
  });

  const ingestionWorker = new Worker<IngestionJobData>(
    INGESTION_QUEUE_NAME,
    async (job: Job<IngestionJobData>) => {
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
        console.error(`[Worker] Dataset ingestion job ${job.data.jobId} failed:`, error);
        await markJobFailed(payload, job.data.jobId, error);

        if (job.data.datasetId) {
          try {
            await payload.update({
              collection: "datasets",
              id: job.data.datasetId,
              data: {
                status: "failed",
                lastError: error instanceof Error ? error.message : String(error),
              } as any,
            });
          } catch (updateErr: unknown) {
            console.error(`[Worker] Could not mark dataset ${job.data.datasetId} as failed:`, updateErr);
          }
        }

        throw error;
      }
    },
    // Concurrency stays at 1 per CLAUDE.md's own note: the per-dataset
    // Redis lock (datasetLock.ts) is what actually protects against two
    // jobs writing the same dataset if this is ever raised, not a
    // guarantee this value provides on its own.
    { connection: redisConnection, concurrency: 1 },
  );

  const documentWorker = new Worker<DocumentIngestionJobData>(
    DOCUMENT_INGESTION_QUEUE_NAME,
    async (job: Job<DocumentIngestionJobData>) => {
      try {
        await processDocumentIngestionJob(job.data, {
          payload,
          geminiDocument,
          claudeSummary,
        });
      } catch (error: unknown) {
        console.error(`[Worker] Document ingestion job ${job.data.jobId} failed:`, error);
        await markJobFailed(payload, job.data.jobId, error);

        try {
          await payload.update({
            collection: "documents",
            id: job.data.documentId,
            data: {
              status: "failed",
              lastError: error instanceof Error ? error.message : String(error),
            } as any,
          });
        } catch (updateErr: unknown) {
          console.error(`[Worker] Could not mark document ${job.data.documentId} as failed:`, updateErr);
        }

        throw error;
      }
    },
    { connection: redisConnection, concurrency: 1 },
  );

  const workers = [ingestionWorker, documentWorker];

  for (const worker of workers) {
    worker.on("completed", (job) => {
      console.log(`[Worker] Job ${job.id} completed.`);
    });
    worker.on("failed", (job, err) => {
      console.error(`[Worker] Job ${job?.id} failed:`, err.message);
    });
  }

  console.log(`[Queue] 👂 Listening on "${INGESTION_QUEUE_NAME}" and "${DOCUMENT_INGESTION_QUEUE_NAME}".`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[Worker] 🛑 Received ${signal}. Gracefully closing workers and connections...`);

    try {
      await Promise.all(workers.map((w) => w.close()));
      await ingestionQueue.close();
      await redisConnection.quit();
      console.log("[Worker] 🟢 Shutdown complete.");
      process.exit(0);
    } catch (err) {
      console.error("[Worker] 🔴 Error during shutdown:", err);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

startWorker().catch((err) => {
  console.error("[Worker] 💥 Fatal bootstrap error:", err);
  process.exit(1);
});
