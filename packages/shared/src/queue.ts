export const INGESTION_QUEUE_NAME = "ingestion";

export type IngestionJobData = {
  jobId: string;
  fileId: string;
  datasetId: string;
  fileHash: string;
};

/**
 * BullMQ requires `maxRetriesPerRequest: null` on connections used by blocking
 * commands, which its workers rely on. Both processes build clients from this
 * one place so the settings cannot drift apart.
 */
export const redisConnectionOptions = {
  maxRetriesPerRequest: null,
} as const;
