import { requireUser } from "@/lib/auth";

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

  try {
    const document = await payload.findByID({
      collection: "documents",
      id,
      depth: 0,
    });

    return Response.json({
      id: String(document.id),
      name: document.name,
      status: document.status,
      lastError: document.lastError ?? null,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    });
  } catch {
    return Response.json({ error: "Document not found." }, { status: 404 });
  }
}
