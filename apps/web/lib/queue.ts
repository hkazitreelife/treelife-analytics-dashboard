import {
  INGESTION_QUEUE_NAME,
  redisConnectionOptions,
  type IngestionJobData,
} from "@analytics/shared";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

const redisUrl = (): string => {
  const url = process.env.REDIS_URL;

  if (!url) {
    throw new Error("Missing required environment variable REDIS_URL.");
  }

  return url;
};

/**
 * One Queue instance per process. Next.js can re-evaluate modules during
 * development, so the instance is cached on globalThis to avoid leaking Redis
 * connections on every hot reload.
 *
 * bullmq 6 treats ioredis as an optional peer and cannot require it lazily from
 * a native ESM context, so the client is constructed here and passed in.
 */
const globalForQueue = globalThis as typeof globalThis & {
  ingestionQueue?: Queue<IngestionJobData>;
};

export const getIngestionQueue = (): Queue<IngestionJobData> => {
  if (!globalForQueue.ingestionQueue) {
    const url = redisUrl();
    const isTls = url.startsWith("rediss://");
    const connection = new Redis(url, {
      ...redisConnectionOptions,
      ...(isTls ? { tls: { rejectUnauthorized: false } } : {}),
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });

    globalForQueue.ingestionQueue = new Queue<IngestionJobData>(
      INGESTION_QUEUE_NAME,
      { connection },
    );
  }

  return globalForQueue.ingestionQueue;
};

export const enqueueIngestion = async (
  data: IngestionJobData,
): Promise<void> => {
  await getIngestionQueue().add("ingest", data, {
    jobId: `job-${data.jobId}`,
    removeOnComplete: false,
    removeOnFail: false,
  });
};
