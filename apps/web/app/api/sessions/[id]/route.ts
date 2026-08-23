import { fileTypeFromFilename } from "@/lib/fileType";
import { requireUser } from "@/lib/auth";
import { getCache, setCache, invalidateCache } from "@/lib/cache";

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

const toRelationId = (entry: unknown): string | number =>
  typeof entry === "object" && entry !== null && "id" in entry
    ? (entry as { id: string | number }).id
    : (entry as string | number);

/**
 * Deletes the session, plus its source when this is a single-source session
 * the worker created solely to wrap that one dataset/document (Sessions.ts:
 * "a session doesn't hold any data of its own"). A combined/multi-source
 * session only groups sources that already have their own independent
 * single-source sessions elsewhere, so deleting it must never touch a
 * dataset/document another session still points at -- only the grouping
 * row is removed in that case.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser(request);

  if (!auth.authenticated) {
    return auth.response;
  }

  const { payload } = auth;
  const { id } = await context.params;

  let session;

  try {
    session = await payload.findByID({ collection: "sessions", id, depth: 0 });
  } catch {
    return Response.json({ error: "Session not found." }, { status: 404 });
  }

  const datasetIds = (Array.isArray(session.datasets) ? session.datasets : []).map(toRelationId);
  const documentIds = (Array.isArray(session.documents) ? session.documents : []).map(toRelationId);

  const isSingleDataset = datasetIds.length === 1 && documentIds.length === 0;
  const isSingleDocument = documentIds.length === 1 && datasetIds.length === 0;

  const deleted: Record<string, unknown> = { sessionId: String(id) };

  try {
    if (isSingleDataset) {
      const datasetId = datasetIds[0]!;

      const jobs = await payload.find({
        collection: "jobs",
        where: { dataset: { equals: datasetId } },
        limit: 200,
        depth: 0,
      });

      const fileIds = new Set<string | number>();

      for (const job of jobs.docs) {
        if (job.file) {
          fileIds.add(toRelationId(job.file));
        }

        await payload.delete({ collection: "jobs", id: job.id });
      }

      const configs = await payload.find({
        collection: "configs",
        where: { dataset: { equals: datasetId } },
        limit: 200,
        depth: 0,
      });

      for (const cfg of configs.docs) {
        await payload.delete({ collection: "configs", id: cfg.id });
      }

      await payload.delete({ collection: "datasets", id: datasetId });

      for (const fileId of fileIds) {
        try {
          await payload.delete({ collection: "files", id: fileId });
        } catch (err) {
          payload.logger.warn(`Could not delete file ${fileId} for dataset ${datasetId}: ${err instanceof Error ? err.message : err}`);
        }
      }

      deleted.datasetId = String(datasetId);
    } else if (isSingleDocument) {
      const documentId = documentIds[0]!;

      const jobs = await payload.find({
        collection: "jobs",
        where: { document: { equals: documentId } },
        limit: 200,
        depth: 0,
      });

      const fileIds = new Set<string | number>();

      for (const job of jobs.docs) {
        if (job.file) {
          fileIds.add(toRelationId(job.file));
        }

        await payload.delete({ collection: "jobs", id: job.id });
      }

      const summaries = await payload.find({
        collection: "summaries",
        where: { document: { equals: documentId } },
        limit: 200,
        depth: 0,
      });

      for (const summary of summaries.docs) {
        await payload.delete({ collection: "summaries", id: summary.id });
      }

      await payload.delete({ collection: "documents", id: documentId });

      for (const fileId of fileIds) {
        try {
          await payload.delete({ collection: "files", id: fileId });
        } catch (err) {
          payload.logger.warn(`Could not delete file ${fileId} for document ${documentId}: ${err instanceof Error ? err.message : err}`);
        }
      }

      deleted.documentId = String(documentId);
    }

    // Missing before this fix: ConversationTurns.session relates to
    // Sessions with no cascade delete, so any session with chat/edit
    // history failed here with a raw Postgres foreign-key error on the
    // sessions delete itself -- confirmed live (4 of 7 real sessions
    // failed this exact way; the 3 that succeeded had no conversation
    // turns yet). clear-nimbus.ts already deletes conversation-turns
    // before its session delete; this endpoint never did.
    const turns = await payload.find({
      collection: "conversation-turns",
      where: { session: { equals: id } },
      limit: 1000,
      depth: 0,
    });

    for (const turn of turns.docs) {
      await payload.delete({ collection: "conversation-turns", id: turn.id });
    }

    await payload.delete({ collection: "sessions", id });
    invalidateCache("session");

    return Response.json({ success: true, deleted });
  } catch (error: unknown) {
    payload.logger.error({ err: error }, `Failed to delete session ${id}.`);

    return Response.json(
      {
        error: "Failed to delete session.",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
