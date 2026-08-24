import { fileTypeFromFilename } from "@/lib/fileType";
import { requireUser } from "@/lib/auth";
import { writeDeterministicSessionOverview } from "@/lib/sessionFallback";
import { inngest } from "@/lib/inngest";
import { getCache, setCache, invalidateCache } from "@/lib/cache";

export const runtime = "nodejs";

type SingleSourceInfo = {
  kind: "dataset" | "document";
  fileType: string | null;
  totalRows: number | null;
  keyPointsCount: number | null;
} | null;

export async function GET(request: Request): Promise<Response> {
  const auth = await requireUser(request);

  if (!auth.authenticated) {
    return auth.response;
  }

  const { payload } = auth;
  const url = new URL(request.url);
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const parsedLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50;

  const cacheKey = `sessions_list_${parsedLimit}`;
  const cached = getCache<Record<string, unknown>>(cacheKey);
  if (cached) {
    return Response.json(cached);
  }

  try {
    const result = await payload.find({
      collection: "sessions",
      limit: parsedLimit,
      depth: 0,
      sort: "-updatedAt",
    });

    // Collect all single-source dataset and document IDs for a single batched query
    const singleDatasetIds: string[] = [];
    const singleDocIds: string[] = [];

    for (const session of result.docs) {
      const dIds = Array.isArray(session.datasets) ? session.datasets : [];
      const docIds = Array.isArray(session.documents) ? session.documents : [];
      if (dIds.length === 1 && docIds.length === 0) {
        singleDatasetIds.push(String(typeof dIds[0] === "object" && dIds[0] !== null && "id" in dIds[0] ? (dIds[0] as any).id : dIds[0]));
      } else if (docIds.length === 1 && dIds.length === 0) {
        singleDocIds.push(String(typeof docIds[0] === "object" && docIds[0] !== null && "id" in docIds[0] ? (docIds[0] as any).id : docIds[0]));
      }
    }

    const [datasetsBatch, docsBatch, summariesBatch] = await Promise.all([
      singleDatasetIds.length > 0
        ? payload.find({
            collection: "datasets",
            where: { id: { in: singleDatasetIds.map(Number) } },
            depth: 1,
            limit: singleDatasetIds.length,
          })
        : Promise.resolve({ docs: [] }),
      singleDocIds.length > 0
        ? payload.find({
            collection: "documents",
            where: { id: { in: singleDocIds.map(Number) } },
            depth: 1,
            limit: singleDocIds.length,
          })
        : Promise.resolve({ docs: [] }),
      singleDocIds.length > 0
        ? payload.find({
            collection: "summaries",
            where: { document: { in: singleDocIds.map(Number) } },
            depth: 0,
            limit: singleDocIds.length * 2,
          })
        : Promise.resolve({ docs: [] }),
    ]);

    const datasetMap = new Map<string, any>(datasetsBatch.docs.map((d: any) => [String(d.id), d]));
    const docMap = new Map<string, any>(docsBatch.docs.map((d: any) => [String(d.id), d]));
    const summaryMap = new Map<string, any>(summariesBatch.docs.map((s: any) => [String(s.document), s]));

    const sessions = result.docs.map((session) => {
      const toId = (entry: unknown): string =>
        typeof entry === "object" && entry !== null && "id" in entry
          ? String((entry as { id: unknown }).id)
          : String(entry);

      const datasetIds = (Array.isArray(session.datasets) ? session.datasets : []).map(toId);
      const documentIds = (Array.isArray(session.documents) ? session.documents : []).map(toId);
      const datasetCount = datasetIds.length;
      const documentCount = documentIds.length;

      let singleSource: SingleSourceInfo = null;

      if (datasetCount === 1 && documentCount === 0) {
        const dataset = datasetMap.get(datasetIds[0]!);
        if (dataset) {
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
        }
      } else if (documentCount === 1 && datasetCount === 0) {
        const document = docMap.get(documentIds[0]!);
        const latestSummary = summaryMap.get(documentIds[0]!);
        const keyPoints = latestSummary?.keyPoints as unknown[] | null | undefined;

        if (document) {
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
      }

      return {
        id: String(session.id),
        name: session.name,
        status: session.status,
        datasetCount,
        documentCount,
        // Full id arrays, not just counts -- lets the "combine existing
        // sessions" action on /new gather every underlying source from
        // whichever sessions the admin selects (single- or already
        // multi-source), regardless of whether they were ever uploaded
        // together in one batch.
        datasetIds,
        documentIds,
        // Only meaningful, and only sent, for the single-source case the
        // reprocess action targets -- a combined session has no one
        // dataset to reprocess.
        singleDatasetId: datasetCount === 1 && documentCount === 0 ? datasetIds[0] : null,
        singleSource,
        findingsCount: Array.isArray(
          (session.overview as { findings?: unknown[] } | null)?.findings,
        )
          ? ((session.overview as { findings: unknown[] }).findings.length)
          : null,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      };
    });

    const responsePayload = { totalDocs: result.totalDocs, sessions };
    setCache(cacheKey, responsePayload, 15_000);

    return Response.json(responsePayload);
  } catch (error: unknown) {
    payload.logger.error({ err: error }, "Failed to list sessions.");

    return Response.json({ error: "Failed to list sessions." }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  const auth = await requireUser(request);

  if (!auth.authenticated) {
    return auth.response;
  }

  const { payload, user } = auth;

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return Response.json({ error: "Request body must be a JSON object." }, { status: 400 });
  }

  const { name, datasetIds, documentIds } = body as {
    name?: unknown;
    datasetIds?: unknown;
    documentIds?: unknown;
  };

  const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);

  if (!isStringArray(datasetIds) || !isStringArray(documentIds)) {
    return Response.json(
      { error: 'Request body must be { "datasetIds": string[], "documentIds": string[], "name"?: string }.' },
      { status: 400 },
    );
  }

  if (datasetIds.length + documentIds.length < 2) {
    return Response.json(
      { error: "A session needs at least two sources; a single file has nothing to combine." },
      { status: 400 },
    );
  }

  const session = await payload.create({
    collection: "sessions",
    data: {
      name: typeof name === "string" && name.trim().length > 0 ? name.trim() : "Combined session",
      // Payload's relationship fields want the id in whatever type the
      // related collection's own id column is (numeric here) -- the request
      // body's ids are strings, same as every other route in this app
      // treats an id.
      datasets: datasetIds.map(Number),
      documents: documentIds.map(Number),
      status: "synthesizing",
      createdBy: user.id,
    },
  });

  // Phase A (the fast half of the same Phase A/Phase B split datasets got):
  // build and store the deterministic combined overview RIGHT NOW, from the
  // sources' already-stored rows -- zero AI calls, sub-second. The session
  // leaves this request ready with a real, validated Overview tab no matter
  // what any model does later. This replaces the old behavior of awaiting
  // runSessionSynthesis inline, which measured 231s end to end when its
  // primary model truncated mid-JSON and a retry followed -- all inside one
  // HTTP request.
  let fallbackWritten = false;

  try {
    const outcome = await writeDeterministicSessionOverview(payload, String(session.id), {
      adminIntent: typeof name === "string" ? name.trim() : undefined,
    });
    fallbackWritten = outcome.written;
  } catch (error: unknown) {
    // A failed fallback build must not fail the request with a 5xx after
    // the session row exists; record why and fall through to the honest
    // empty-overview outcome below (the same thing a total AI failure used
    // to produce, now at least labeled).
    payload.logger.warn(
      `Deterministic session overview for session ${session.id} failed to build: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!fallbackWritten) {
    // No dataset in this session has stored tables (documents-only batch,
    // or every dataset lost its data). There is genuinely nothing
    // deterministic to show and nothing for an AI dashboard upgrade to
    // build from either -- so no Phase B event is fired. Findings could
    // still theoretically apply to a documents-only session, but without
    // any dataset metric side they can never satisfy the finding contract;
    // recording the honest empty state beats pretending otherwise.
    await payload.update({
      collection: "sessions",
      id: session.id,
      data: { status: "ready", overview: { findings: [] } },
    });

    invalidateCache("session");

    return Response.json({
      sessionId: String(session.id),
      status: "ready",
      upgraded: false,
      reason: "no_dataset_tables",
    });
  }

  // Phase B handoff: a fast outbound event send, not an AI wait. If Inngest
  // itself is unreachable, the fallback is ALREADY live and stored, so the
  // admin loses only the future upgrade, never the session -- logged, not
  // failed.
  let handoffWarning: string | null = null;

  try {
    await inngest.send({
      name: "session/synthesis-requested",
      data: {
        sessionId: String(session.id),
        adminIntent: typeof name === "string" ? name.trim() : null,
      },
    });
  } catch (error: unknown) {
    handoffWarning =
      error instanceof Error ? error.message : String(error);
    payload.logger.warn(
      `Could not queue the AI upgrade for session ${session.id}; the deterministic fallback stays live. ${handoffWarning}`,
    );
  }

  invalidateCache("session");

  return Response.json({
    sessionId: String(session.id),
    status: "ready",
    upgraded: false,
    pendingUpgrade: !handoffWarning,
    ...(handoffWarning ? { warning: "AI upgrade could not be queued; showing the deterministic overview." } : {}),
  });
}
