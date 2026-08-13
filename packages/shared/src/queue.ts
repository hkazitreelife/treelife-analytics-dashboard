export const INGESTION_QUEUE_NAME = "ingestion";

export type IngestionJobData = {
  jobId: string;
  fileId: string;
  datasetId: string;
  fileHash: string;
};

/**
 * Section 10.0. A second, parallel queue for the narrative-document pipeline
 * -- deliberately not reusing INGESTION_QUEUE_NAME/IngestionJobData, which
 * stay exactly as they are for the Section 14 table path. Consumed by a
 * second BullMQ Worker in the same worker process (still two runtime
 * processes total, not a third), calling processDocumentIngestionJob
 * instead of processIngestionJob.
 */
export const DOCUMENT_INGESTION_QUEUE_NAME = "document-ingestion";

export type DocumentIngestionJobData = {
  jobId: string;
  fileId: string;
  documentId: string;
  fileHash: string;
};

/**
 * Section 18.1. The three events the worker publishes and the SSE route
 * forwards. Frontend refetches the affected resource on receipt rather than
 * mutating state from the payload (Section 18.3/30.7) — so the payload
 * stays intentionally minimal, never dataset rows or config content.
 */
export const DATASET_EVENT_TYPES = [
  "job.updated",
  "dataset.updated",
  "config.updated",
] as const;

export type DatasetEventType = (typeof DATASET_EVENT_TYPES)[number];

/** Section 18.2 minimum payload. */
export type DatasetEventPayload = {
  event: DatasetEventType;
  datasetId: string;
  jobId: string | null;
  timestamp: string;
};

/**
 * One Redis pub/sub channel per dataset, so the dataset-scoped SSE route
 * (Section 20.10) subscribes to exactly the events its own dashboard cares
 * about rather than filtering a global stream.
 */
export const datasetEventChannel = (datasetId: string): string =>
  `events:dataset:${datasetId}`;

/**
 * BullMQ requires `maxRetriesPerRequest: null` on connections used by blocking
 * commands, which its workers rely on. Both processes build clients from this
 * one place so the settings cannot drift apart.
 */
export const redisConnectionOptions = {
  maxRetriesPerRequest: null,
} as const;
