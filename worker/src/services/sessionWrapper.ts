import type { Payload } from "payload";

/**
 * Prompt 15.0 Part 1. "Every dataset and document, on ingestion, gets
 * wrapped in ... a Session record with exactly one source." Called once,
 * right after a dataset/document's own ingestion succeeds -- never before,
 * so a session is never created for a still-processing or failed source.
 *
 * Idempotent: a re-ingestion of the same dataset/document (a corrected
 * re-upload) must not create a second single-source session for it, so
 * this checks for an existing session naming exactly this one source
 * (and no other) before creating one.
 */
export const ensureSingleSourceSession = async (
  payload: Payload,
  kind: "dataset" | "document",
  sourceId: string,
  sourceName: string,
): Promise<void> => {
  const whereField = kind === "dataset" ? "datasets" : "documents";
  const otherField = kind === "dataset" ? "documents" : "datasets";

  const existing = await payload.find({
    collection: "sessions",
    where: {
      [whereField]: { equals: Number(sourceId) },
    },
    limit: 50,
    depth: 0,
  });

  // A single-source session for this exact source already exists (created
  // on this source's own first successful ingestion) -- do not create a
  // second one. A session that ALSO references other sources (a combined
  // session built by Section session-synthesis) does not count as this
  // source's own single-source wrapper, so it's excluded here.
  const alreadyWrapped = existing.docs.some((session) => {
    const own = Array.isArray(session[whereField]) ? session[whereField].length : 0;
    const other = Array.isArray(session[otherField]) ? session[otherField].length : 0;
    return own === 1 && other === 0;
  });

  if (alreadyWrapped) {
    return;
  }

  await payload.create({
    collection: "sessions",
    data: {
      name: sourceName,
      [whereField]: [Number(sourceId)],
      status: "ready",
      overview: { findings: [] },
    },
  });
};
