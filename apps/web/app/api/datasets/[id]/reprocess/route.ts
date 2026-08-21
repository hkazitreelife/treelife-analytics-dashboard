import { requireUser } from "@/lib/auth";
import { processIngestionDirectly } from "@/lib/directIngestion";
import { invalidateCache } from "@/lib/cache";

export const runtime = "nodejs";

/**
 * Repairs a dataset that was ingested before directIngestion.ts wrote
 * dataset.data/totalRows and called ensureSingleSourceSession (commits
 * 9242311, a458536). Those datasets are stuck permanently -- their status
 * is "ready" so nothing would ever naturally re-run their ingestion -- and
 * re-uploading the same file is the only other way to fix them, which
 * needs the admin to still have the original file on hand.
 *
 * Re-runs the exact same ingestion function against the ORIGINAL bytes
 * already stored on this dataset's File row (Files.dataBase64, kept
 * specifically because local disk storage doesn't persist on Vercel's
 * serverless filesystem), so no re-upload is needed. Safe to call on an
 * already-correct dataset too: it just re-derives the same config from the
 * same bytes, no different than a fresh upload of that same file would.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser(request);

  if (!auth.authenticated) {
    return auth.response;
  }

  const { payload } = auth;
  const { id } = await context.params;

  let dataset;

  try {
    dataset = await payload.findByID({ collection: "datasets", id, depth: 1 });
  } catch {
    return Response.json({ error: "Dataset not found." }, { status: 404 });
  }

  const file =
    typeof dataset.currentFile === "object" && dataset.currentFile !== null
      ? dataset.currentFile
      : null;

  if (!file) {
    return Response.json(
      { error: "This dataset has no associated file to reprocess from." },
      { status: 409 },
    );
  }

  const dataBase64 = (file as any).dataBase64 as string | undefined;

  if (!dataBase64) {
    return Response.json(
      {
        error:
          "This dataset's original file bytes are not stored (it may predate that safeguard). Re-upload the source file instead.",
      },
      { status: 409 },
    );
  }

  const buffer = Buffer.from(dataBase64, "base64");
  const filename = (file as any).filename || `${dataset.name}.xlsx`;

  const job = await payload.create({
    collection: "jobs",
    data: {
      file: (file as any).id,
      dataset: Number(id),
      fileHash: dataset.currentFileHash ?? "",
      status: "queued",
      retryCount: 0,
    },
  });

  try {
    await processIngestionDirectly(payload, job.id, Number(id), buffer, filename, undefined);
  } catch (error: unknown) {
    payload.logger.error({ err: error }, `Reprocessing failed for dataset ${id}.`);

    return Response.json(
      {
        error: "Reprocessing failed.",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }

  invalidateCache("dataset");
  invalidateCache("session");
  invalidateCache("config");

  return Response.json({ success: true, datasetId: String(id), jobId: String(job.id) });
}
