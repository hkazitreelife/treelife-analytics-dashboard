import { requireUser } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * Prompt 15.0 Part 1: "there is no longer a meaningful distinction between
 * a session with one dataset and a dataset." /datasets/:id (still directly
 * linkable for back-compat) uses this to find the single-source session
 * that wraps it and redirect there -- the one place this dataset is now
 * actually rendered from.
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

  const candidates = await payload.find({
    collection: "sessions",
    where: { datasets: { equals: Number(id) } },
    limit: 50,
    depth: 0,
  });

  const wrapper = candidates.docs.find((session) => {
    const datasets = Array.isArray(session.datasets) ? session.datasets : [];
    const documents = Array.isArray(session.documents) ? session.documents : [];
    return datasets.length === 1 && documents.length === 0;
  });

  if (!wrapper) {
    return Response.json({ error: "No session wraps this dataset yet." }, { status: 404 });
  }

  return Response.json({ sessionId: String(wrapper.id) });
}
