import { requireUser } from "@/lib/auth";

export const runtime = "nodejs";

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
    const dataset = await payload.findByID({
      collection: "datasets",
      id,
      depth: 0,
    });

    return Response.json({
      id: String(dataset.id),
      name: dataset.name,
      status: dataset.status,
      totalRows: dataset.totalRows ?? 0,
      tableNames: (dataset.tableNames ?? []).map((entry) => entry.tableName),
      currentFileHash: dataset.currentFileHash ?? null,
      // The real technical error from the most recent failed job against this
      // dataset, so the dashboard can show why an upload failed instead of a
      // generic canned string. Null once a later job succeeds.
      lastError: dataset.lastError ?? null,
      createdAt: dataset.createdAt,
      updatedAt: dataset.updatedAt,
    });
  } catch {
    return Response.json({ error: "Dataset not found." }, { status: 404 });
  }
}
