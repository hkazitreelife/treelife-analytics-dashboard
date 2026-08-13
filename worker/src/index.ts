import { randomUUID } from "node:crypto";
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

/**
 * Section 10.6. This exact failure -- a worker process from an earlier
 * session still alive, still connected to Redis/BullMQ, silently grabbing
 * jobs meant for a fresher instance -- has now happened three times this
 * session, each discovered only by hand (checking process start times,
 * killing PIDs by guesswork). This is the fix: a single Redis key
 * (WORKER_HEARTBEAT_REDIS_KEY, already written every 30s by every
 * instance) doubles as a single-owner lock, checked here before either
 * Worker subscribes to anything.
 *
 * Chosen approach: TAKE OVER, don't refuse to start. Refusing to start
 * would leave the actually-harmful process (the stale one) still running
 * and still silently able to grab jobs -- it would only stop a fresh,
 * correct instance from becoming available, which is the opposite of
 * what's wanted. Starting a new worker process is a deliberate operator
 * action (a restart after a code change, or exactly this kind of
 * incident response); the new instance is who SHOULD end up owning the
 * queues. So: this instance writes its own instanceId into the key
 * immediately, and the periodic heartbeat tick below checks, every time,
 * whether the key still holds ITS OWN id -- if some other instance has
 * since overwritten it, THIS instance (now the stale one) shuts itself
 * down. That is the "old one is forced to release" half: cooperative, via
 * the same heartbeat mechanism, not an OS-level kill -- one process
 * cannot safely or portably force-kill another it has no PID/handle for,
 * but it CAN reliably notice "I am no longer the current owner" and exit.
 *
 * Limit worth stating plainly: this only works between instances that
 * both run this code. A worker already running from BEFORE this change
 * has no eviction check in it at all and will never notice being taken
 * over -- it has to be killed by hand once, same as the three times this
 * already happened. This prevents the failure going forward, it does not
 * retroactively fix an already-running old-code zombie.
 */
const instanceId = randomUUID();

const existingHeartbeatRaw = await connection.get(WORKER_HEARTBEAT_REDIS_KEY);
let existingHeartbeat: WorkerHeartbeatPayload | null = null;

if (existingHeartbeatRaw) {
  try {
    existingHeartbeat = JSON.parse(existingHeartbeatRaw) as WorkerHeartbeatPayload;
  } catch {
    existingHeartbeat = null;
  }
}

if (existingHeartbeat) {
  const priorAgeSeconds = Math.round(
    (Date.now() - new Date(existingHeartbeat.timestamp).getTime()) / 1000,
  );

  payload.logger.warn(
    `Detected a pre-existing worker heartbeat (instance ${existingHeartbeat.instanceId}, last updated ${priorAgeSeconds}s ago). This new instance (${instanceId}) is taking over as the active worker on both queues. The previous instance will detect this and shut itself down on its next heartbeat tick, within ${WORKER_HEARTBEAT_INTERVAL_MS / 1000}s, if it is running code new enough to check for this; if it predates this safeguard, it will keep running and must be stopped manually.`,
  );
} else {
  payload.logger.info(
    `No pre-existing worker heartbeat found. Starting as the active instance (${instanceId}).`,
  );
}

const HEARTBEAT_QUEUES = [INGESTION_QUEUE_NAME, DOCUMENT_INGESTION_QUEUE_NAME];

const writeHeartbeat = async (): Promise<void> => {
  const heartbeat: WorkerHeartbeatPayload = {
    instanceId,
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

// Claims the key -- overwriting whatever was there -- before either Worker
// below subscribes to anything. This is the "take over" half; the
// "previous instance releases" half is that same previous instance's own
// heartbeat tick noticing the mismatch (see the interval further down).
await writeHeartbeat();

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
 * Section 10.1 Part 2 / Section 10.6. Proves the worker's own event loop is
 * still alive and looping, not just that it started successfully -- what
 * actually happened earlier this session was a worker that logged its
 * startup lines and then silently stopped consuming a queue, with no
 * further signal either way. This does NOT prove either Worker is actively
 * consuming (a worker can be alive and heartbeating while genuinely wedged
 * inside a stuck job, or if this setInterval callback itself were somehow
 * starved) -- see GET /api/health/queues in the web process for the
 * complementary check (how long the oldest queued job has waited), which
 * is what actually catches "alive but not consuming."
 *
 * Section 10.6's addition: every tick first checks whether this instance
 * still owns the key. If a newer instance has overwritten it with a
 * different instanceId, this one is the stale loser of a takeover and
 * shuts itself down rather than keep silently competing for jobs.
 */
const heartbeatInterval = setInterval(() => {
  void (async (): Promise<void> => {
    try {
      const currentRaw = await connection.get(WORKER_HEARTBEAT_REDIS_KEY);
      const current = currentRaw
        ? (JSON.parse(currentRaw) as WorkerHeartbeatPayload)
        : null;

      if (current && current.instanceId !== instanceId) {
        payload.logger.error(
          `This worker's heartbeat lock was taken over by another instance (${current.instanceId}). Shutting down to avoid running as a stale, silently-competing worker.`,
        );
        await shutdown("lock-taken-over");
        return;
      }

      await writeHeartbeat();
      payload.logger.info(
        `Worker heartbeat: alive, listening on ${HEARTBEAT_QUEUES.join(", ")}.`,
      );
    } catch (error: unknown) {
      payload.logger.error({ err: error }, "Failed to write worker heartbeat.");
    }
  })();
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
