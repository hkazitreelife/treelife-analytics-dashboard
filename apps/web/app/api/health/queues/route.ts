import {
  STALE_QUEUE_THRESHOLD_MS,
  WORKER_HEARTBEAT_REDIS_KEY,
  type WorkerHeartbeatPayload,
} from "@analytics/shared";
import { Redis } from "ioredis";

import { requireUser } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * Section 10.1 Part 2 item 5. A lightweight, honest check, not production
 * monitoring: two independent signals, checked on request, nothing polled
 * or alerted automatically.
 *
 * 1. The worker's heartbeat key in Redis (see workerHealth.ts) -- present
 *    and recent means the worker process is alive and its event loop is
 *    still looping. Missing or stale means it likely isn't, or Redis
 *    itself is unreachable, which this cannot tell apart.
 * 2. The oldest job still in Payload's "queued" status, across both the
 *    dataset and document pipelines (Jobs collection is shared). A queued
 *    job waiting past STALE_QUEUE_THRESHOLD_MS is worth surfacing even if
 *    the heartbeat looks fine -- exactly the failure mode this session
 *    actually hit: the worker was alive, logging normally, and had simply
 *    stopped consuming the new queue. Heartbeat alone would have missed
 *    that; this check is what would have caught it.
 *
 * Limits, stated plainly: this reads Payload/Redis once per request, with
 * no history, no alerting, and no distinction between "one slow job" and
 * "the worker is actually dead" beyond the one threshold. It is a signal
 * to check by hand (or wire into a real monitor later), not a monitor
 * itself.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await requireUser(request);

  if (!auth.authenticated) {
    return auth.response;
  }

  const { payload } = auth;

  let heartbeat: {
    present: boolean;
    instanceId: string | null;
    ageSeconds: number | null;
    queues: string[] | null;
  } = { present: false, instanceId: null, ageSeconds: null, queues: null };

  try {
    const redisUrl = process.env.REDIS_URL;

    if (redisUrl) {
      // A short-lived connection for this one read -- deliberately not the
      // shared BullMQ connections in lib/queue.ts/lib/documentQueue.ts,
      // so a health check can never contend with real queue traffic.
      const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });

      try {
        await redis.connect();
        const raw = await redis.get(WORKER_HEARTBEAT_REDIS_KEY);

        if (raw) {
          const parsed = JSON.parse(raw) as WorkerHeartbeatPayload;
          const ageMs = Date.now() - new Date(parsed.timestamp).getTime();

          heartbeat = {
            present: true,
            // Section 10.6: which single instance currently holds the
            // heartbeat/lock -- useful for confirming a takeover actually
            // happened, without checking process start times by hand.
            instanceId: parsed.instanceId,
            ageSeconds: Math.max(0, Math.round(ageMs / 1000)),
            queues: parsed.queues,
          };
        }
      } finally {
        redis.disconnect();
      }
    }
  } catch (error: unknown) {
    payload.logger.error({ err: error }, "Could not read worker heartbeat from Redis.");
  }

  const oldestQueued = await payload.find({
    collection: "jobs",
    where: { status: { equals: "queued" } },
    sort: "createdAt",
    limit: 1,
    depth: 0,
  });

  const oldest = oldestQueued.docs[0];
  const oldestAgeMs = oldest ? Date.now() - new Date(oldest.createdAt).getTime() : null;
  const queueIsStale = oldestAgeMs !== null && oldestAgeMs > STALE_QUEUE_THRESHOLD_MS;

  let signal: string;

  if (queueIsStale) {
    signal =
      "STALE: a job has been queued longer than the threshold. The worker may be stuck, not consuming, or down.";
  } else if (!heartbeat.present) {
    signal =
      "WARNING: no worker heartbeat found in Redis. The worker may not be running, or Redis is unreachable.";
  } else {
    signal = "OK: heartbeat is recent and no job has waited past the threshold.";
  }

  return Response.json({
    signal,
    heartbeat,
    oldestQueuedJob: oldest
      ? {
          jobId: String(oldest.id),
          ageSeconds: Math.round((oldestAgeMs ?? 0) / 1000),
          kind:
            oldest.dataset !== null && oldest.dataset !== undefined
              ? "dataset"
              : oldest.document !== null && oldest.document !== undefined
                ? "document"
                : "unknown",
        }
      : null,
    staleQueueThresholdSeconds: STALE_QUEUE_THRESHOLD_MS / 1000,
  });
}
