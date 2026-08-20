import { requireUser } from "@/lib/auth";

export const runtime = "nodejs";

/** Mirrors GET /api/datasets/:id/session exactly, for a Document. */
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

  const candidates = await payload.find({
    collection: "sessions",
    where: { documents: { equals: Number(id) } },
    limit: 50,
    depth: 0,
  });

  const wrapper = candidates.docs.find((session) => {
    const datasets = Array.isArray(session.datasets) ? session.datasets : [];
    const documents = Array.isArray(session.documents) ? session.documents : [];
    return documents.length === 1 && datasets.length === 0;
  });

  if (!wrapper) {
    return Response.json({ error: "No session wraps this document yet." }, { status: 404 });
  }

  return Response.json({ sessionId: String(wrapper.id) });
}
