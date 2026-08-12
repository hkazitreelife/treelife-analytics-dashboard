import type { Redis } from "ioredis";

/**
 * Per-dataset ingestion lock (PRD 11.4). Prevents two jobs from writing to the
 * same Dataset concurrently if worker concurrency is ever raised above 1.
 * Built on the same Redis connection the worker already holds for BullMQ, not
 * a second connection: this module never constructs its own.
 */

const LOCK_PREFIX = "dataset-lock:";

/**
 * Padded well beyond the observed worst case for a single ingestion job: one
 * Gemini call plus one stricter retry, one Claude call plus one stricter
 * retry, each of which can itself take tens of seconds. 5 minutes leaves
 * headroom without leaving a genuinely dead job's lock held indefinitely if
 * the worker process is killed before it releases.
 */
export const LOCK_TTL_MS = 5 * 60 * 1000;

export const lockKey = (datasetId: string): string => `${LOCK_PREFIX}${datasetId}`;

export type DatasetLock = {
  /**
   * Attempts to acquire the exclusive lock for `datasetId`, stamped with
   * `token`. Returns true if this call obtained it, false if another job
   * already holds it. NX+PX in a single SET call: no separate existence
   * check, so there is no window between checking and setting for another
   * job to race into.
   */
  acquireLock: (datasetId: string, token: string) => Promise<boolean>;
  /**
   * Releases the lock only if it is still stamped with `token`. A bare DEL
   * would let a job whose lock has already expired (or was never its own)
   * delete a lock a different job has since acquired, so this is
   * GET-then-compare-then-DEL as a single atomic Lua script, never a bare
   * DEL.
   */
  releaseLock: (datasetId: string, token: string) => Promise<boolean>;
};

const RELEASE_IF_OWNER_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

export const createDatasetLock = (redis: Redis): DatasetLock => ({
  acquireLock: async (datasetId, token) => {
    const result = await redis.set(
      lockKey(datasetId),
      token,
      "PX",
      LOCK_TTL_MS,
      "NX",
    );

    return result === "OK";
  },

  releaseLock: async (datasetId, token) => {
    const result = await redis.eval(
      RELEASE_IF_OWNER_SCRIPT,
      1,
      lockKey(datasetId),
      token,
    );

    return result === 1;
  },
});
