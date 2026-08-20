import { fileTypeFromFilename } from "@/lib/fileType";
import { requireUser } from "@/lib/auth";
import { getCache, setCache } from "@/lib/cache";

export const runtime = "nodejs";

type RelationEntry = string | number | { id: string | number; name?: string };

const asIdNamePairs = (
  value: unknown,
): { id: string; name: string | null }[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return (value as RelationEntry[]).map((entry) =>
    typeof entry === "object" && entry !== null
      ? { id: String(entry.id), name: entry.name ?? null }
      : { id: String(entry), name: null },
  );
};

/** Mirrors GET /api/datasets/:id, for one Session. */
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

  const cacheKey = `session_detail_${id}`;
  const cached = getCache<Record<string, unknown>>(cacheKey);
  if (cached) {
    return Response.json(cached);
  }

  try {
    const session = await payload.findByID({ collection: "sessions", id, depth: 1 });

    const datasets = asIdNamePairs(session.datasets);
    const documents = asIdNamePairs(session.documents);

    let singleSource:
      | { kind: "dataset" | "document"; fileType: string | null; totalRows: number | null; keyPointsCount: number | null }
      | null = null;

    if (datasets.length === 1 && documents.length === 0) {
      const dataset = await payload.findByID({ collection: "datasets", id: datasets[0]!.id, depth: 1 });

      singleSource = {
        kind: "dataset",
        fileType: fileTypeFromFilename(
          typeof dataset.currentFile === "object" && dataset.currentFile
            ? dataset.currentFile.filename
            : null,
        ),
        totalRows: dataset.totalRows ?? 0,
        keyPointsCount: null,
      };
    } else if (documents.length === 1 && datasets.length === 0) {
      const [document, latestSummary] = await Promise.all([
        payload.findByID({ collection: "documents", id: documents[0]!.id, depth: 1 }),
        payload.find({
          collection: "summaries",
          where: { document: { equals: documents[0]!.id } },
          sort: "-version",
          limit: 1,
          depth: 0,
        }),
      ]);
      const keyPoints = latestSummary.docs[0]?.keyPoints as unknown[] | null | undefined;

      singleSource = {
        kind: "document",
        fileType: fileTypeFromFilename(
          typeof document.currentFile === "object" && document.currentFile
            ? document.currentFile.filename
            : null,
        ),
        totalRows: null,
        keyPointsCount: Array.isArray(keyPoints) ? keyPoints.length : null,
      };
    }

    const payloadResponse = {
      id: String(session.id),
      name: session.name,
      status: session.status,
      lastError: session.lastError ?? null,
      datasets,
      documents,
      singleSource,
      overview: session.overview ?? { findings: [] },
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };

    setCache(cacheKey, payloadResponse, 30_000);

    return Response.json(payloadResponse);
  } catch {
    return Response.json({ error: "Session not found." }, { status: 404 });
  }
}
