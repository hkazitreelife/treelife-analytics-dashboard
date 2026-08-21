import { Redis } from "ioredis";
import { redisConnectionOptions } from "@analytics/shared";

/**
 * Best-effort per-dataset lock for the in-process ingestion path
 * (directIngestion.ts), mirroring worker/src/services/datasetLock.ts's
 * NX+PX acquire / GET-compare-DEL release pattern (built for the exact
 * same reason: stop two ingestion runs against the same dataset from
 * racing -- here, a double-clicked "Repair dashboard data" or the same
 * reprocess request fired from two tabs, since this path has no BullMQ
 * concurrency=1 guarantee to fall back on).
 *
 * Deliberately fails OPEN, unlike the worker's version: if REDIS_URL isn't
 * set or Redis is unreachable, acquireDatasetLock reports success with a
 * null handle (meaning "no lock was actually taken, proceed anyway")
 * instead of blocking ingestion. This lock narrows a race window that
 * didn't exist as a guard before today; it must never become a new way
 * for a Redis blip to make every upload fail.
 */

const LOCK_PREFIX = "direct-ingestion-lock:";
const LOCK_TTL_MS = 5 * 60 * 1000;

const globalForLock = globalThis as typeof globalThis & {
  directIngestionLockRedis?: Redis | null;
};

const getLockRedis = (): Redis | null => {
  if (globalForLock.directIngestionLockRedis !== undefined) {
    return globalForLock.directIngestionLockRedis;
  }

  const url = process.env.REDIS_URL;

  if (!url) {
    globalForLock.directIngestionLockRedis = null;
    return null;
  }

  try {
    const isTls = url.startsWith("rediss://");
    const client = new Redis(url, {
      ...redisConnectionOptions,
      ...(isTls ? { tls: { rejectUnauthorized: false } } : {}),
      enableReadyCheck: false,
      // A bad/unreachable URL must fail fast, not hang this request
      // retrying a connection indefinitely.
      retryStrategy: () => null,
      maxRetriesPerRequest: 1,
    });

    // Swallowed deliberately: acquireDatasetLock/releaseDatasetLock below
    // already wrap every call in try/catch and fail open. An unhandled
    // "error" event on the client itself would otherwise crash the
    // process, which locking must never be able to do.
    client.on("error", () => {});

    globalForLock.directIngestionLockRedis = client;
    return client;
  } catch {
    globalForLock.directIngestionLockRedis = null;
    return null;
  }
};

const lockKey = (datasetId: string | number): string => `${LOCK_PREFIX}${datasetId}`;

const RELEASE_IF_OWNER_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

export type DatasetLockHandle = { datasetId: string | number; token: string } | null;

export type AcquireLockResult = { acquired: boolean; handle: DatasetLockHandle };

export const acquireDatasetLock = async (
  datasetId: string | number,
): Promise<AcquireLockResult> => {
  const redis = getLockRedis();

  if (!redis) {
    return { acquired: true, handle: null };
  }

  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    const result = await redis.set(lockKey(datasetId), token, "PX", LOCK_TTL_MS, "NX");

    if (result === "OK") {
      return { acquired: true, handle: { datasetId, token } };
    }

    return { acquired: false, handle: null };
  } catch {
    // Redis constructed a client but a live call failed -- fail open
    // rather than block ingestion on a transient error.
    return { acquired: true, handle: null };
  }
};

export const releaseDatasetLock = async (handle: DatasetLockHandle): Promise<void> => {
  if (!handle) {
    return;
  }

  const redis = getLockRedis();

  if (!redis) {
    return;
  }

  try {
    await redis.eval(RELEASE_IF_OWNER_SCRIPT, 1, lockKey(handle.datasetId), handle.token);
  } catch {
    // Best effort: a failed release just means the lock expires on its
    // own TTL instead of being cleared immediately.
  }
};

/** Thrown by processIngestionDirectly when another run already holds this dataset's lock. */
export class DatasetIngestionLockedError extends Error {
  constructor(datasetId: string | number) {
    super(`Dataset ${datasetId} is already being processed by another request.`);
    this.name = "DatasetIngestionLockedError";
  }
}
