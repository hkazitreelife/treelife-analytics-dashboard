import { z } from "zod";

import { requireUser } from "@/lib/auth";
import { enqueueDocumentIngestion } from "@/lib/documentQueue";
import { enqueueIngestion } from "@/lib/queue";
import { baseNameWithoutExtension } from "@/lib/uploads";

export const runtime = "nodejs";

/**
 * Section 10.1: exactly one of existingDatasetId/existingDocumentId, never
 * both, mirroring which resource the name-collision check in
 * apps/web/app/api/uploads/route.ts actually found.
 */
const confirmSchema = z
  .object({
    fileId: z.string().min(1),
    existingDatasetId: z.string().min(1).optional(),
    existingDocumentId: z.string().min(1).optional(),
    choice: z.enum(["update_existing", "create_new"]),
  })
  .refine(
    (data) => Boolean(data.existingDatasetId) !== Boolean(data.existingDocumentId),
    {
      message:
        "Exactly one of existingDatasetId or existingDocumentId must be provided.",
    },
  );

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
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const parsed = confirmSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request.", detail: parsed.error.issues },
      { status: 400 },
    );
  }

  const { fileId, existingDatasetId, existingDocumentId, choice } = parsed.data;

  try {
    const file = await payload.findByID({
      collection: "files",
      id: fileId,
      depth: 0,
    });

    if (!file.sha256) {
      return Response.json(
        { error: "File record has no hash. Re-upload the file." },
        { status: 409 },
      );
    }

    // Section 10.1: what "update existing" means for a changed narrative
    // document, decided explicitly, not silently assumed.
    //
    // For a dataset, "update existing" is already a full replace: the new
    // parse's tables[] entirely replaces the old ones once it validates --
    // there is no concept of merging old and new spreadsheet rows.
    //
    // A document's summary is different in kind: it is Claude's judgment
    // call about what matters in THIS text, not a literal parse of
    // unambiguous structure. If the file's content actually changed (a
    // different hash under the same name), the old summary was a judgment
    // about different words -- keeping any of its keyPoints, or asking
    // Claude to "expand" on stale content, would silently mix commentary
    // about two different documents into one list. So "update existing"
    // here means the same kind of full replace as the dataset path, not a
    // merge: re-run extraction (Gemini) and summary generation (Claude)
    // from scratch against the NEW file, entirely replacing the Document's
    // stored fullText/sections, and writing a brand-new keyPoints list.
    // That new list still becomes the next Summaries version (never
    // hardcoded, same versioning discipline as everywhere else) -- the OLD
    // summary is kept as history, exactly like an old Config version, but
    // it is not read from or built on. This is the existing
    // processDocumentIngestionJob's normal behavior unchanged: it already
    // generates fresh from whatever fullText/sections it just extracted,
    // never referencing a prior summary. No processor change was needed,
    // only wiring a job at the existing documentId instead of a new one.
    if (existingDocumentId) {
      let documentId: number;

      if (choice === "update_existing") {
        const existing = await payload.update({
          collection: "documents",
          id: existingDocumentId,
          data: { status: "updating" },
        });

        documentId = existing.id;
      } else {
        const baseName = baseNameWithoutExtension(file.filename ?? "document");

        const created = await payload.create({
          collection: "documents",
          data: {
            name: `${baseName} (${file.sha256.slice(0, 8)})`,
            currentFile: file.id,
            currentFileHash: file.sha256,
            status: "processing",
            createdBy: user.id,
          },
        });

        documentId = created.id;
      }

      const job = await payload.create({
        collection: "jobs",
        data: {
          file: file.id,
          document: documentId,
          fileHash: file.sha256,
          status: "queued",
          retryCount: 0,
        },
      });

      await enqueueDocumentIngestion({
        jobId: String(job.id),
        fileId: String(file.id),
        documentId: String(documentId),
        fileHash: file.sha256,
      });

      return Response.json(
        { jobId: String(job.id), documentId: String(documentId), status: "queued" },
        { status: 202 },
      );
    }

    let datasetId: number;

    if (choice === "update_existing") {
      // The existing dataset keeps its data until the new parse validates.
      const existing = await payload.update({
        collection: "datasets",
        id: existingDatasetId!,
        data: { status: "updating" },
      });

      datasetId = existing.id;
    } else {
      const baseName = baseNameWithoutExtension(file.filename ?? "dataset");

      const created = await payload.create({
        collection: "datasets",
        data: {
          // Suffixed so the new dataset does not collide with the existing name.
          name: `${baseName} (${file.sha256.slice(0, 8)})`,
          currentFile: file.id,
          currentFileHash: file.sha256,
          status: "processing",
          totalRows: 0,
          createdBy: user.id,
        },
      });

      datasetId = created.id;
    }

    const job = await payload.create({
      collection: "jobs",
      data: {
        file: file.id,
        dataset: datasetId,
        fileHash: file.sha256,
        status: "queued",
        retryCount: 0,
      },
    });

    await enqueueIngestion({
      jobId: String(job.id),
      fileId: String(file.id),
      datasetId: String(datasetId),
      fileHash: file.sha256,
    });

    return Response.json(
      { jobId: String(job.id), datasetId: String(datasetId), status: "queued" },
      { status: 202 },
    );
  } catch (error: unknown) {
    payload.logger.error({ err: error }, "Upload confirmation failed.");

    return Response.json(
      {
        error: "Upload confirmation failed.",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
