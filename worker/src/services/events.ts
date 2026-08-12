import {
  datasetEventChannel,
  type DatasetEventType,
} from "@analytics/shared";
import type { Redis } from "ioredis";

/**
 * Section 18. Publishes to Redis pub/sub on every job/dataset/config status
 * change; the web process's dataset-scoped SSE route subscribes and forwards.
 * Uses the worker's existing Redis connection — `publish` is a normal command
 * and does not require a dedicated subscriber-mode client the way SUBSCRIBE
 * does, so no second connection is opened for this.
 */

export type DatasetEventPublisher = {
  publish: (
    event: DatasetEventType,
    datasetId: string,
    jobId: string | null,
  ) => Promise<void>;
};

export const createDatasetEventPublisher = (
  redis: Redis,
): DatasetEventPublisher => ({
  publish: async (event, datasetId, jobId) => {
    const payload = {
      event,
      datasetId,
      jobId,
      timestamp: new Date().toISOString(),
    };

    await redis.publish(
      datasetEventChannel(datasetId),
      JSON.stringify(payload),
    );
  },
});
