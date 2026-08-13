/**
 * Section 10.1 Part 2. A lightweight, honest liveness signal -- not
 * production monitoring. It answers one narrow question this session
 * actually ran into: is the worker process alive and still looping, as
 * opposed to running but stuck (exactly what happened earlier this
 * session, when the running worker had gone stale and simply stopped
 * consuming the new document queue with no visible symptom at all).
 *
 * What this does NOT do: alert anyone, restart anything, or distinguish
 * "briefly slow" from "truly stuck" beyond the one threshold below. It is
 * a value to check, by hand or by a future real monitor, nothing more.
 */

/** The Redis key the worker writes its heartbeat to. */
export const WORKER_HEARTBEAT_REDIS_KEY = "worker:heartbeat";

/** How often the worker refreshes it. */
export const WORKER_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * The key's TTL in Redis. Set well above the interval (3x) so a single
 * slow tick doesn't make the key expire and read as "worker is dead" when
 * it isn't -- but short enough that a truly-stopped worker's heartbeat
 * disappears within a couple of minutes rather than lingering for hours.
 */
export const WORKER_HEARTBEAT_TTL_SECONDS = 90;

export type WorkerHeartbeatPayload = {
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
