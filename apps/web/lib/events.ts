import {
  datasetEventChannel,
  redisConnectionOptions,
  type DatasetEventType,
} from "@analytics/shared";
import { Redis } from "ioredis";

/**
 * Section 18. The web-side publisher, for events raised by web-process code
 * (prompt editing) rather than the worker (worker/src/services/events.ts).
 * Same channel helper, same payload shape, so the dataset-scoped SSE route
 * forwards either source identically.
 *
 * One Redis client per process, cached on globalThis so Next.js's dev-mode
 * module reloads don't leak connections -- the same pattern lib/queue.ts
 * uses for its Queue instance. publish is a normal command, not a dedicated
 * subscriber-mode client the way SUBSCRIBE is, so this can be a plain,
 * reusable client.
 */

const redisUrl = (): string => {
  const url = process.env.REDIS_URL;

  if (!url) {
    throw new Error("Missing required environment variable REDIS_URL.");
  }

  return url;
};

const globalForEvents = globalThis as typeof globalThis & {
  eventsPublisherConnection?: Redis;
};

const getConnection = (): Redis => {
  globalForEvents.eventsPublisherConnection ??= new Redis(
    redisUrl(),
    redisConnectionOptions,
  );

  return globalForEvents.eventsPublisherConnection;
};

export const publishDatasetEvent = async (
  event: DatasetEventType,
  datasetId: string,
  jobId: string | null,
): Promise<void> => {
  const payload = {
    event,
    datasetId,
    jobId,
    timestamp: new Date().toISOString(),
  };

  await getConnection().publish(
    datasetEventChannel(datasetId),
    JSON.stringify(payload),
  );
};
