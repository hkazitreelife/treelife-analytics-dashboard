import { requireUser } from "@/lib/auth";
import { ensureSingleSourceSession } from "@/lib/sessionWrapper";

export const runtime = "nodejs";

const findWrapper = (sessions: { id: string | number; datasets?: unknown; documents?: unknown }[]) =>
  sessions.find((session) => {
    const datasets = Array.isArray(session.datasets) ? session.datasets : [];
    const documents = Array.isArray(session.documents) ? session.documents : [];
    return datasets.length === 1 && documents.length === 0;
  });

/**
 * Prompt 15.0 Part 1: "there is no longer a meaningful distinction between
 * a session with one dataset and a dataset." /datasets/:id (still directly
 * linkable for back-compat) uses this to find the single-source session
 * that wraps it and redirect there -- the one place this dataset is now
 * actually rendered from.
 *
 * Self-healing: directIngestion.ts's in-process path (used in production)
 * did not call ensureSingleSourceSession until it was added there, so any
 * dataset ingested before that fix has no wrapping session and would 404
 * here forever otherwise. ensureSingleSourceSession is idempotent, so
 * creating the missing wrapper here, once, on first lookup is safe and
 * fixes every already-ingested dataset without a manual backfill.
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

  let wrapper = findWrapper(candidates.docs as any);

  if (!wrapper) {
    let dataset;

    try {
      dataset = await payload.findByID({ collection: "datasets", id, depth: 0 });
    } catch {
      return Response.json({ error: "Dataset not found." }, { status: 404 });
    }

    if (dataset.status !== "ready") {
      return Response.json(
        { error: "This dataset has not finished processing yet." },
        { status: 409 },
      );
    }

    await ensureSingleSourceSession(payload, "dataset", id, dataset.name);

    const retry = await payload.find({
      collection: "sessions",
      where: { datasets: { equals: Number(id) } },
      limit: 50,
      depth: 0,
    });

    wrapper = findWrapper(retry.docs as any);
  }

  if (!wrapper) {
    return Response.json({ error: "No session wraps this dataset yet." }, { status: 404 });
  }

  return Response.json({ sessionId: String(wrapper.id) });
}
