import { requireUser } from "@/lib/auth";
import { getCache, setCache } from "@/lib/cache";

export const runtime = "nodejs";

/**
 * Prompt 15.0 Part 2 item 5. Reopening a session restores its complete
 * chat/edit history -- this is what the right panel loads on mount instead
 * of starting blank. Sorted oldest-first (real conversation order); Payload
 * already gives every row its own createdAt.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser(request);

  if (!auth.authenticated) {
    return auth.response;
  }

  const { payload } = auth;
  const { id } = await context.params;

  const cacheKey = `session_turns_${id}`;
  const cached = getCache<Record<string, unknown>>(cacheKey);
  if (cached) {
    return Response.json(cached);
  }

  try {
    const result = await payload.find({
      collection: "conversation-turns",
      where: { session: { equals: Number(id) } },
      sort: "createdAt",
      limit: 500,
      depth: 0,
    });

    const body = {
      turns: result.docs.map((turn) => ({
        id: String(turn.id),
        kind: turn.kind,
        message: turn.message,
        status: turn.status,
        response: turn.response,
        targetSourceKind: turn.targetSourceKind ?? null,
        targetSourceId: turn.targetSourceId ?? null,
        createdAt: turn.createdAt,
      })),
    };

    setCache(cacheKey, body, 30_000);

    return Response.json(body);
  } catch (error: unknown) {
    payload.logger.error({ err: error }, `Failed to load turns for session ${id}.`);

    return Response.json({ error: "Failed to load conversation history." }, { status: 500 });
  }
}
