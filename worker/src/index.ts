import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DOCUMENT_INGESTION_QUEUE_NAME,
  INGESTION_QUEUE_NAME,
  redisConnectionOptions,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_REDIS_KEY,
  WORKER_HEARTBEAT_TTL_SECONDS,
  type DocumentIngestionJobData,
  type IngestionJobData,
  type WorkerHeartbeatPayload,
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
// Section 10.0's narrative-document pipeline: separate services, separate
// processor, separate queue below. Nothing above this line changes.
const { createGeminiDocumentClient } = await import("./services/geminiDocument");
const { createClaudeDocumentSummaryClient } = await import(
  "./services/claudeDocumentSummary"
);
const { processDocumentIngestionJob } = await import(
  "./processors/documentIngestion"
);

const payload = await getPayload({ config });
const gemini = createGeminiClient(geminiApiKey);
const claude = createClaudeConfigClient(anthropicApiKey);
const geminiDocument = createGeminiDocumentClient(geminiApiKey);
const claudeSummary = createClaudeDocumentSummaryClient(anthropicApiKey);
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

/**
 * Section 10.0. A second Worker on a second queue in this same process --
 * still two runtime processes total (web + worker), not a third. Mirrors
 * recordFailure/the dataset worker above exactly, but for Documents: a
 * failed job never overwrites already-stored document data, and the
 * technical error is denormalized onto the Document the same way it is onto
 * a Dataset. No dataset.updated/config.updated events: the document pipeline
 * has no SSE route in this pass (Section 10.0 did not ask for one); the
 * upload UI polls /api/jobs/:id, exactly like the dataset path already does
 * before its own SSE takes over.
 */
const recordDocumentFailure = async (
  data: DocumentIngestionJobData,
  message: string,
): Promise<void> => {
  try {
    await payload.update({
      collection: "jobs",
      id: data.jobId,
      data: { status: "failed", error: message },
    });

    await payload.update({
      collection: "documents",
      id: data.documentId,
      data: { status: "failed", lastError: message },
    });
  } catch (updateError: unknown) {
    payload.logger.error(
      { err: updateError },
      "Could not record document job failure.",
    );
  }
};

const documentWorker = new Worker<DocumentIngestionJobData>(
  DOCUMENT_INGESTION_QUEUE_NAME,
  async (job) => {
    try {
      await processDocumentIngestionJob(job.data, {
        payload,
        geminiDocument,
        claudeSummary,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);

      await recordDocumentFailure(job.data, message);

      throw error;
    }
  },
  {
    connection,
    concurrency: 1,
  },
);

documentWorker.on("completed", (job) => {
  payload.logger.info(`Document job ${job.data.jobId} completed.`);
});

documentWorker.on("failed", (job, error) => {
  payload.logger.error(
    { err: error },
    `Document job ${job?.data.jobId ?? "unknown"} failed.`,
  );
});

payload.logger.info(
  `Worker listening on queue "${DOCUMENT_INGESTION_QUEUE_NAME}". Press Ctrl+C to stop.`,
);

/**
 * Section 10.1 Part 2. Proves the worker's own event loop is still alive and
 * looping, not just that it started successfully -- what actually happened
 * earlier this session was a worker that logged its startup lines and then
 * silently stopped consuming a queue, with no further signal either way.
 * This does NOT prove either Worker is actively consuming (a worker can be
 * alive and heartbeating while genuinely wedged inside a stuck job, or if
 * this setInterval callback itself were somehow starved) -- see
 * GET /api/health/queues in the web process for the complementary check
 * (how long the oldest queued job has waited), which is what actually
 * catches "alive but not consuming."
 */
const HEARTBEAT_QUEUES = [INGESTION_QUEUE_NAME, DOCUMENT_INGESTION_QUEUE_NAME];

const writeHeartbeat = async (): Promise<void> => {
  const heartbeat: WorkerHeartbeatPayload = {
    timestamp: new Date().toISOString(),
    queues: HEARTBEAT_QUEUES,
  };

  await connection.set(
    WORKER_HEARTBEAT_REDIS_KEY,
    JSON.stringify(heartbeat),
    "EX",
    WORKER_HEARTBEAT_TTL_SECONDS,
  );
};

void writeHeartbeat().catch((error: unknown) =>
  payload.logger.error({ err: error }, "Failed to write initial worker heartbeat."),
);

const heartbeatInterval = setInterval(() => {
  void writeHeartbeat()
    .then(() => {
      payload.logger.info(
        `Worker heartbeat: alive, listening on ${HEARTBEAT_QUEUES.join(", ")}.`,
      );
    })
    .catch((error: unknown) => {
      payload.logger.error({ err: error }, "Failed to write worker heartbeat.");
    });
}, WORKER_HEARTBEAT_INTERVAL_MS);

const shutdown = async (signal: string): Promise<void> => {
  payload.logger.info(`Received ${signal}. Shutting down worker.`);

  clearInterval(heartbeatInterval);
  await worker.close();
  await documentWorker.close();
  await ingestionQueue.close();
  connection.disconnect();
  await payload.db.destroy?.();

  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
