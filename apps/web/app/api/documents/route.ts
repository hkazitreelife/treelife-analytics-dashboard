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
      depth: 0,
      sort: "-updatedAt",
    });

    return Response.json({
      totalDocs: result.totalDocs,
      documents: result.docs.map((document) => ({
        id: String(document.id),
        name: document.name,
        status: document.status,
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
      })),
    });
  } catch (error: unknown) {
    payload.logger.error({ err: error }, "Failed to list documents.");

    return Response.json({ error: "Failed to list documents." }, { status: 500 });
  }
}
