import { fileTypeFromFilename } from "@/lib/fileType";
import { requireUser } from "@/lib/auth";
import { getCache, setCache } from "@/lib/cache";

export const runtime = "nodejs";

/** Section 10.0. Mirrors GET /api/datasets/:id, for one Document. */
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

  const cacheKey = `document_meta_${id}`;
  const cached = getCache<Record<string, unknown>>(cacheKey);
  if (cached) {
    return Response.json(cached);
  }

  try {
    const document = await payload.findByID({
      collection: "documents",
      id,
      // depth: 1 so currentFile populates with its filename, for fileType.
      depth: 1,
    });

    // Prompt 12.0: same key-point count the sidebar/Context card needs,
    // read-only, from the latest Summary version.
    const latestSummary = await payload.find({
      collection: "summaries",
      where: { document: { equals: id } },
      sort: "-version",
      limit: 1,
      depth: 0,
    });

    const keyPoints = latestSummary.docs[0]?.keyPoints as
      | unknown[]
      | null
      | undefined;

    const body = {
      id: String(document.id),
      name: document.name,
      status: document.status,
      fileType: fileTypeFromFilename(
        typeof document.currentFile === "object" && document.currentFile
          ? document.currentFile.filename
          : null,
      ),
      keyPointsCount: Array.isArray(keyPoints) ? keyPoints.length : null,
      lastError: document.lastError ?? null,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    };

    setCache(cacheKey, body, 60_000);

    return Response.json(body);
  } catch {
    return Response.json({ error: "Document not found." }, { status: 404 });
  }
}
