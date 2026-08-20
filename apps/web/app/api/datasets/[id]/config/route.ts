import { requireUser } from "@/lib/auth";
import { getCache, setCache } from "@/lib/cache";

export const runtime = "nodejs";

/**
 * Section 20.7. Returns the latest config version for a dataset. Config and
 * data are separate stores, so this never returns dataset rows.
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

  const cacheKey = `dataset_config_${id}`;
  const cached = getCache<Record<string, unknown>>(cacheKey);
  if (cached) {
    return Response.json(cached);
  }

  try {
    const result = await payload.find({
      collection: "configs",
      where: { dataset: { equals: id } },
      limit: 1,
      depth: 0,
      // -createdAt is a tiebreaker: version is written as (max existing
      // version for this dataset) + 1, so it should already be unique per
      // dataset, but this keeps the query deterministic even against rows
      // written before that fix, or against any future write path that
      // doesn't go through it.
      sort: "-version,-createdAt",
    });

    const latest = result.docs[0];

    if (!latest) {
      return Response.json(
        {
          error:
            "No dashboard config exists for this dataset yet. It is generated when ingestion completes.",
        },
        { status: 404 },
      );
    }

    const body = {
      id: String(latest.id),
      datasetId: id,
      version: latest.version,
      generatedBy: latest.generatedBy,
      config: latest.config,
      insights: latest.insights,
      createdAt: latest.createdAt,
      updatedAt: latest.updatedAt,
    };

    setCache(cacheKey, body, 60_000);

    return Response.json(body);
  } catch (error: unknown) {
    payload.logger.error({ err: error }, "Failed to load dashboard config.");

    return Response.json(
      { error: "Failed to load dashboard config." },
      { status: 500 },
    );
  }
}
