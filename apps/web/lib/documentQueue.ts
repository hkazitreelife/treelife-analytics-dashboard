import {
  DOCUMENT_INGESTION_QUEUE_NAME,
  redisConnectionOptions,
  type DocumentIngestionJobData,
} from "@analytics/shared";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

/**
 * Section 10.0. Mirrors lib/queue.ts exactly, for the document pipeline's
 * own queue -- lib/queue.ts itself is untouched.
 */

const redisUrl = (): string => {
  const url = process.env.REDIS_URL;

  if (!url) {
    throw new Error("Missing required environment variable REDIS_URL.");
  }

  return url;
};

const globalForQueue = globalThis as typeof globalThis & {
  documentIngestionQueue?: Queue<DocumentIngestionJobData>;
};

export const getDocumentIngestionQueue = (): Queue<DocumentIngestionJobData> => {
  if (!globalForQueue.documentIngestionQueue) {
    const connection = new Redis(redisUrl(), redisConnectionOptions);

    globalForQueue.documentIngestionQueue = new Queue<DocumentIngestionJobData>(
      DOCUMENT_INGESTION_QUEUE_NAME,
      { connection },
    );
  }

  return globalForQueue.documentIngestionQueue;
};

export const enqueueDocumentIngestion = async (
  data: DocumentIngestionJobData,
): Promise<void> => {
  await getDocumentIngestionQueue().add("ingest-document", data, {
    jobId: `job-${data.jobId}`,
    removeOnComplete: false,
    removeOnFail: false,
  });
};
