import { datasetEventChannel, redisConnectionOptions } from "@analytics/shared";
import { Redis } from "ioredis";

import { requireUser } from "@/lib/auth";

export const runtime = "nodejs";
// Never statically optimized or cached: this is a long-lived stream, not a
// resource with a snapshot-able response body.
export const dynamic = "force-dynamic";

/**
 * Section 18 / 20.10. Dataset-scoped SSE stream. One dedicated Redis
 * subscriber connection per open browser connection — SUBSCRIBE puts a
 * client into a mode where it can no longer run other commands, so this
 * cannot reuse a shared connection the way publish (worker side) or simple
 * command calls (other routes) do.
 *
 * Payload is exactly the Section 18.2 shape: event/datasetId/jobId/timestamp,
 * never rows, never config content. The frontend refetches the affected
 * resource on receipt (Section 18.3/30.7), so there is nothing else to send.
 */

const HEARTBEAT_MS = 25_000;

const redisUrl = (): string => {
  const url = process.env.REDIS_URL;

  if (!url) {
    throw new Error("Missing required environment variable REDIS_URL.");
  }

  return url;
};

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser(request);

  if (!auth.authenticated) {
    return auth.response;
  }

  const { id } = await context.params;
  const channel = datasetEventChannel(id);
  const subscriber = new Redis(redisUrl(), redisConnectionOptions);

  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;

      const send = (chunk: string): void => {
        if (closed) {
          return;
        }

        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Controller already closed on the other side of a race with
          // cleanup(); nothing left to send to.
        }
      };

      const cleanup = (): void => {
        if (closed) {
          return;
        }

        closed = true;

        if (heartbeat) {
          clearInterval(heartbeat);
        }

        subscriber.unsubscribe(channel).catch(() => {});
        subscriber.quit().catch(() => {});

        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      subscriber.on("message", (_receivedChannel, message) => {
        // Section 18.2's payload always carries its own "event" field, so the
        // SSE `event:` line and the JSON body agree on what happened; a
        // malformed payload still gets forwarded, as a generic message,
        // rather than silently dropped.
        let eventType = "message";

        try {
          const parsed = JSON.parse(message) as { event?: unknown };

          if (typeof parsed.event === "string") {
            eventType = parsed.event;
          }
        } catch {
          // Leave eventType as "message".
        }

        send(`event: ${eventType}\ndata: ${message}\n\n`);
      });

      subscriber.on("error", (error) => {
        send(`: subscriber error: ${error instanceof Error ? error.message : String(error)}\n\n`);
      });

      await subscriber.subscribe(channel);

      // A comment line, not a real event: keeps intermediary proxies and
      // idle-connection timeouts from treating the stream as dead.
      heartbeat = setInterval(() => {
        send(": heartbeat\n\n");
      }, HEARTBEAT_MS);

      request.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      subscriber.unsubscribe(channel).catch(() => {});
      subscriber.quit().catch(() => {});

      if (heartbeat) {
        clearInterval(heartbeat);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disables response buffering on nginx-style proxies, which would
      // otherwise hold the stream open with nothing reaching the client.
      "X-Accel-Buffering": "no",
    },
  });
}
