/**
 * Section 10.1 Part 2 / Section 10.6. A lightweight, honest liveness signal
 * -- not production monitoring -- that has grown a second job: the same
 * key doubles as a single-owner lock, because the same underlying failure
 * (a worker process alive and still looping, but not the one that should
 * be) showed up twice more as "two worker processes silently connected to
 * the same queues, one of them stale, splitting jobs between them with no
 * error anywhere." See worker/src/index.ts's startup/heartbeat-tick logic
 * for the takeover/eviction mechanism this key now supports.
 *
 * What this does NOT do: alert anyone, restart anything, or distinguish
 * "briefly slow" from "truly stuck" beyond the one threshold below. It is
 * a value to check, by hand or by a future real monitor, nothing more.
 */

/** The Redis key the worker writes its heartbeat/lock to. */
export const WORKER_HEARTBEAT_REDIS_KEY = "worker:heartbeat";

/** How often the worker refreshes it. */
export const WORKER_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * The key's TTL in Redis. Set well above the interval (3x) so a single
 * slow tick doesn't make the key expire and read as "worker is dead" when
 * it isn't -- but short enough that a truly-stopped worker's heartbeat
 * disappears within a couple of minutes rather than lingering for hours.
 *
 * This is also the answer to "what happens if the process is killed
 * uncleanly and never releases the lock": nothing needs to release it --
 * the key simply expires on its own after this many seconds with no
 * further writes, exactly like a heartbeat going silent. A crashed
 * process cannot leave a permanent lock behind; the worst case is a
 * bounded ~90s window where the key still shows the dead instance as
 * "owner" before it expires.
 */
export const WORKER_HEARTBEAT_TTL_SECONDS = 90;

export type WorkerHeartbeatPayload = {
  /**
   * Section 10.6: a fresh random id per process (crypto.randomUUID(),
   * generated once at startup), not a PID -- PIDs get reused by the OS and
   * would make "is this still the same process" ambiguous. Whichever
   * instance's id is currently in this key is the one, singular, allowed
   * to be actively consuming both queues.
   */
  instanceId: string;
  timestamp: string;
  queues: string[];
};

/**
 * How long a job may sit in "queued" before that's worth surfacing as a
 * signal something's wrong, per Section 10.1 item 5's "a few minutes,
 * given expected processing time." A real extraction+summary run in this
 * session took under 90 seconds end to end; this threshold is set well
 * above normal processing time, not tuned to any SLA.
 */
export const STALE_QUEUE_THRESHOLD_MS = 5 * 60 * 1000;
