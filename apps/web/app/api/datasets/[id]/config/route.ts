import { requireUser } from "@/lib/auth";

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

  try {
    const result = await payload.find({
      collection: "configs",
      where: { dataset: { equals: id } },
      limit: 1,
      depth: 0,
      sort: "-version",
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

    return Response.json({
      id: String(latest.id),
      datasetId: id,
      version: latest.version,
      generatedBy: latest.generatedBy,
      config: latest.config,
      insights: latest.insights,
      createdAt: latest.createdAt,
      updatedAt: latest.updatedAt,
    });
  } catch (error: unknown) {
    payload.logger.error({ err: error }, "Failed to load dashboard config.");

    return Response.json(
      { error: "Failed to load dashboard config." },
      { status: 500 },
    );
  }
}
