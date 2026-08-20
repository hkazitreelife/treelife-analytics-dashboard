import { Redis, type RedisOptions } from "ioredis";

/**
 * Queue names used across the analytics workspace.
 * Supports both generic 'dataset-ingestion' and existing domain queues.
 */
export const QUEUE_NAMES = {
  DATASET_INGESTION: "dataset-ingestion",
  INGESTION: "ingestion",
  DOCUMENT_INGESTION: "document-ingestion",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface DatasetIngestionJobData {
  jobId: string;
  fileId: string;
  datasetId?: string;
  documentId?: string;
  fileKey?: string;
  fileName?: string;
  fileMimeType?: string;
  intentPrompt?: string;
}

/**
 * Constructs a resilient Redis connection suitable for Upstash or standalone Redis.
 * Ensures maxRetriesPerRequest is set to null (required by BullMQ).
 */
export const createRedisConnection = (customUrl?: string): Redis => {
  const connectionUrl =
    customUrl || process.env.REDIS_URL || "redis://127.0.0.1:6379";

  const isTls = connectionUrl.startsWith("rediss://");

  const options: RedisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: (times: number) => {
      const delay = Math.min(times * 200, 2000);
      return delay;
    },
    ...(isTls
      ? {
          tls: {
            rejectUnauthorized: false,
          },
        }
      : {}),
  };

  return new Redis(connectionUrl, options);
};
