import { fileTypeFromFilename } from "@/lib/fileType";
import { requireUser } from "@/lib/auth";
import { getCache, setCache } from "@/lib/cache";

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

  const cacheKey = `dataset_meta_${id}`;
  const cached = getCache<Record<string, unknown>>(cacheKey);
  if (cached) {
    return Response.json(cached);
  }

  try {
    const dataset = await payload.findByID({
      collection: "datasets",
      id,
      // depth: 1 so currentFile populates with its filename, for fileType.
      depth: 1,
    });

    const body = {
      id: String(dataset.id),
      name: dataset.name,
      status: dataset.status,
      totalRows: dataset.totalRows ?? 0,
      tableNames: (dataset.tableNames ?? []).map((entry) => entry.tableName),
      // Prompt 12.0: the right panel's Context card type badge.
      fileType: fileTypeFromFilename(
        typeof dataset.currentFile === "object" && dataset.currentFile
          ? dataset.currentFile.filename
          : null,
      ),
      currentFileHash: dataset.currentFileHash ?? null,
      // The real technical error from the most recent failed job against this
      // dataset, so the dashboard can show why an upload failed instead of a
      // generic canned string. Null once a later job succeeds.
      lastError: dataset.lastError ?? null,
      createdAt: dataset.createdAt,
      updatedAt: dataset.updatedAt,
    };

    setCache(cacheKey, body, 60_000);

    return Response.json(body);
  } catch {
    return Response.json({ error: "Dataset not found." }, { status: 404 });
  }
}
