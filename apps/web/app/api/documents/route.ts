import { fileTypeFromFilename } from "@/lib/fileType";
import { requireUser } from "@/lib/auth";

export const runtime = "nodejs";

/** Section 10.0. Mirrors GET /api/datasets exactly, for Documents. */
export async function GET(request: Request): Promise<Response> {
  const auth = await requireUser(request);

  if (!auth.authenticated) {
    return auth.response;
  }

  const { payload } = auth;
  const url = new URL(request.url);
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);

  try {
    const result = await payload.find({
      collection: "documents",
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50,
      // depth: 1 so currentFile populates with its filename, for fileType --
      // see lib/fileType.ts's doc comment on why this reads Files.filename
      // rather than document.data.sourceFile.type.
      depth: 1,
      sort: "-updatedAt",
    });

    // Prompt 12.0: the sidebar shows a key-point count per document, the
    // same way it shows a row count per dataset. A document itself doesn't
    // store that count -- it lives on its latest Summary version -- so this
    // fetches one summary per document, in parallel, read-only. Never
    // touches keyPoints content or quote verification.
    const documents = await Promise.all(
      result.docs.map(async (document) => {
        const latestSummary = await payload.find({
          collection: "summaries",
          where: { document: { equals: document.id } },
          sort: "-version",
          limit: 1,
          depth: 0,
        });

        const keyPoints = latestSummary.docs[0]?.keyPoints as
          | unknown[]
          | null
          | undefined;

        return {
          id: String(document.id),
          name: document.name,
          status: document.status,
          fileType: fileTypeFromFilename(
            typeof document.currentFile === "object" && document.currentFile
              ? document.currentFile.filename
              : null,
          ),
          keyPointsCount: Array.isArray(keyPoints) ? keyPoints.length : null,
          createdAt: document.createdAt,
          updatedAt: document.updatedAt,
        };
      }),
    );

    return Response.json({
      totalDocs: result.totalDocs,
      documents,
    });
  } catch (error: unknown) {
    payload.logger.error({ err: error }, "Failed to list documents.");

    return Response.json({ error: "Failed to list documents." }, { status: 500 });
  }
}
