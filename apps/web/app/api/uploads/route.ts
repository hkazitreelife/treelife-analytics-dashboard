import { requireUser } from "@/lib/auth";
import { inngest } from "@/lib/inngest";
import {
  baseNameWithoutExtension,
  isDocumentCandidateFileType,
  maxUploadBytes,
  resolveFileType,
  sha256,
  supportedExtensions,
} from "@/lib/uploads";

export const runtime = "nodejs";
// Both branches go through Inngest (inngest.send below, handled by
// /api/inngest -> lib/inngestFunctions.ts), which runs the real ingestion
// logic as a durable background job instead of this request blocking on
// it -- so this route itself no longer needs a large maxDuration;
// inngest.send is a fast outbound HTTP call, not the parse + AI
// generation. Documents were migrated after datasets (their extraction
// logic had to be ported into apps/web first: geminiDocument.ts,
// claudeDocumentSummary.ts, documentDetector.ts, directDocumentIngestion.ts)
// -- this route no longer uses BullMQ/Redis for job processing at all.
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  const auth = await requireUser(request);

  if (!auth.authenticated) {
    return auth.response;
  }

  const { payload, user } = auth;

  let formData: FormData;

  try {
    formData = await request.formData();
  } catch {
    return Response.json(
      { error: "Expected multipart/form-data with a 'file' field." },
      { status: 400 },
    );
  }

  const uploaded = formData.get("file");

  if (!(uploaded instanceof File)) {
    return Response.json(
      { error: "Missing 'file' field." },
      { status: 400 },
    );
  }

  // Prompt 15.0 Part 4: optional, free-text intent typed alongside the
  // upload on /new. Purely additive -- absent, this behaves identically to
  // before. Stored on the Job row; the worker reads it and passes it into
  // the initial config/summary-generation call as framing only.
  const intentField = formData.get("intent");
  const intentPrompt =
    typeof intentField === "string" && intentField.trim().length > 0
      ? intentField.trim().slice(0, 2000)
      : undefined;

  const limit = maxUploadBytes();

  if (uploaded.size > limit) {
    return Response.json(
      {
        error: `File exceeds the ${limit / (1024 * 1024)} MB limit. Nothing was imported.`,
      },
      { status: 413 },
    );
  }

  if (uploaded.size === 0) {
    return Response.json({ error: "File is empty." }, { status: 400 });
  }

  const fileType = resolveFileType(uploaded.name, uploaded.type);

  if (!fileType) {
    return Response.json(
      {
        error: `Unsupported file type. Allowed extensions: ${supportedExtensions().join(", ")}. The extension and MIME type must agree.`,
      },
      { status: 415 },
    );
  }

  const bytes = Buffer.from(await uploaded.arrayBuffer());
  // File identity is the hash of the bytes, never the filename.
  const hash = sha256(bytes);
  const datasetName = baseNameWithoutExtension(uploaded.name);

  // Section 10.0/10.1: a PDF/PPTX/DOCX goes to the narrative-document
  // pipeline (Documents/Summaries), never Datasets/Configs. Self-contained
  // branch, with the exact same duplicate-hash short-circuit and
  // name-collision prompt as the dataset flow below it -- see
  // apps/web/app/api/uploads/confirm/route.ts's document branch for what
  // "update existing" means for a changed document, since a summary isn't
  // a literal parse the way tables[] is.
  if (isDocumentCandidateFileType(fileType)) {
    try {
      // Same rule as the dataset flow: a matching hash alone is not a
      // duplicate, only a completed Job with a Document attached counts.
      const hashMatches = await payload.find({
        collection: "files",
        where: { sha256: { equals: hash } },
        limit: 100,
        depth: 0,
      });

      for (const candidate of hashMatches.docs) {
        const completedJob = await payload.find({
          collection: "jobs",
          where: {
            and: [
              { file: { equals: candidate.id } },
              { status: { equals: "completed" } },
              { document: { exists: true } },
            ],
          },
          limit: 1,
          depth: 0,
        });

        const job = completedJob.docs[0];

        if (job?.document !== null && job?.document !== undefined) {
          return Response.json(
            {
              status: "duplicate_noop",
              fileId: String(candidate.id),
              existingDocumentId: String(job.document),
              message: "File already processed.",
            },
            { status: 200 },
          );
        }
      }

      const created = await payload.create({
        collection: "files",
        data: {
          sha256: hash,
          uploadedBy: user.id,
          dataBase64: bytes.toString("base64"),
        } as any,
        file: {
          data: bytes,
          mimetype: uploaded.type,
          name: uploaded.name,
          size: uploaded.size,
        },
      });

      if (created.filename) {
        await payload.update({
          collection: "files",
          id: created.id,
          data: { storagePath: `media/${created.filename}` },
        });
      }

      const nameCollision = await payload.find({
        collection: "documents",
        where: { name: { equals: datasetName } },
        limit: 1,
        depth: 0,
      });

      const collidingDocument = nameCollision.docs[0];

      if (collidingDocument) {
        return Response.json(
          {
            requiresUserChoice: true,
            existingDocumentId: String(collidingDocument.id),
            fileId: String(created.id),
            message:
              "A document with this filename exists. Choose whether to update it or create a new document.",
          },
          { status: 200 },
        );
      }

      const document = await payload.create({
        collection: "documents",
        data: {
          name: datasetName,
          currentFile: created.id,
          currentFileHash: hash,
          status: "processing",
          createdBy: user.id,
        },
      });

      const job = await payload.create({
        collection: "jobs",
        data: {
          file: created.id,
          document: document.id,
          fileHash: hash,
          status: "queued",
          retryCount: 0,
          intentPrompt,
        },
      });

      // Reverted from BullMQ+Redis to Inngest, same as the dataset branch:
      // documents were the deliberately-deferred half of the earlier
      // Inngest migration (their extraction logic lived only in the
      // worker package), now ported into apps/web
      // (lib/directDocumentIngestion.ts) so this can move too. Removes
      // the last Redis dependency for job processing.
      await inngest.send({
        name: "document/uploaded",
        data: {
          jobId: String(job.id),
          fileId: String(created.id),
          documentId: String(document.id),
          fileHash: hash,
          intentPrompt,
        },
      });

      return Response.json(
        {
          jobId: String(job.id),
          fileId: String(created.id),
          documentId: String(document.id),
          status: "queued",
          requiresUserChoice: false,
        },
        { status: 202 },
      );
    } catch (error: unknown) {
      payload.logger.error({ err: error }, "Document upload failed.");

      return Response.json(
        {
          error: "Upload failed.",
          detail: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      );
    }
  }

  try {
    // A matching hash alone is not a duplicate. The prior upload counts only if
    // it actually finished: a completed Job with a Dataset attached. An
    // abandoned collision flow leaves a File row behind with no completed Job,
    // and that must be treated as a fresh candidate rather than silently
    // short-circuited into a duplicate.
    const hashMatches = await payload.find({
      collection: "files",
      where: { sha256: { equals: hash } },
      limit: 100,
      depth: 0,
    });

    for (const candidate of hashMatches.docs) {
      const completedJob = await payload.find({
        collection: "jobs",
        where: {
          and: [
            { file: { equals: candidate.id } },
            { status: { equals: "completed" } },
            { dataset: { exists: true } },
          ],
        },
        limit: 1,
        depth: 0,
      });

      const job = completedJob.docs[0];

      if (job?.dataset !== null && job?.dataset !== undefined) {
        return Response.json(
          {
            status: "duplicate_noop",
            fileId: String(candidate.id),
            existingDatasetId: String(job.dataset),
            message: "File already processed.",
          },
          { status: 200 },
        );
      }
    }

    const created = await payload.create({
      collection: "files",
      data: {
        sha256: hash,
        uploadedBy: user.id,
        dataBase64: bytes.toString("base64"),
      } as any,
      file: {
        data: bytes,
        mimetype: uploaded.type,
        name: uploaded.name,
        size: uploaded.size,
      },
    });

    // Payload may deduplicate the stored filename, so the path is recorded from
    // the created document rather than from the incoming name.
    if (created.filename) {
      await payload.update({
        collection: "files",
        id: created.id,
        data: { storagePath: `media/${created.filename}` },
      });
    }

    const nameCollision = await payload.find({
      collection: "datasets",
      where: { name: { equals: datasetName } },
      limit: 1,
      depth: 0,
    });

    const collidingDataset = nameCollision.docs[0];

    if (collidingDataset) {
      return Response.json(
        {
          requiresUserChoice: true,
          existingDatasetId: String(collidingDataset.id),
          fileId: String(created.id),
          message:
            "A dataset with this filename exists. Choose whether to update it or create a new dataset.",
        },
        { status: 200 },
      );
    }

    const dataset = await payload.create({
      collection: "datasets",
      data: {
        name: datasetName,
        currentFile: created.id,
        currentFileHash: hash,
        status: "processing",
        totalRows: 0,
        createdBy: user.id,
      },
    });

    const job = await payload.create({
      collection: "jobs",
      data: {
        file: created.id,
        dataset: dataset.id,
        fileHash: hash,
        status: "queued",
        retryCount: 0,
        intentPrompt,
      },
    });

    // Fire-and-forget via Inngest, which calls back into /api/inngest to
    // actually run processIngestionDirectly as a durable background job --
    // this request never blocks on parsing or an AI call, matching the
    // documented design ("returns 202 immediately, never blocking on an AI
    // call"). Previously this ran processIngestionDirectly synchronously,
    // with BullMQ+Redis as a fallback only if that threw; Inngest replaces
    // both the synchronous call and that fallback, and needs no Redis at
    // all for this path.
    try {
      await inngest.send({
        name: "dataset/uploaded",
        data: {
          jobId: String(job.id),
          datasetId: String(dataset.id),
          fileId: String(created.id),
          filename: uploaded.name,
          intentPrompt,
        },
      });
    } catch (sendErr: unknown) {
      payload.logger.error({ err: sendErr }, "Failed to enqueue dataset ingestion via Inngest.");

      await payload.update({
        collection: "jobs",
        id: job.id,
        data: {
          status: "failed",
          error: `Could not schedule ingestion: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`,
        },
      });

      // Actionable, not generic: the File/Dataset rows already exist, so
      // "try again" alone would re-upload needlessly. Name the dataset and
      // give the two real remediations -- start the local Inngest runtime,
      // or hit the existing Repair/Reprocess flow once it's up.
      return Response.json(
        {
          error:
            "Upload saved, but ingestion could not be scheduled -- Inngest is unreachable locally. Start it with `npx inngest-cli@latest dev -u http://localhost:3000/api/inngest`, then open this dataset and choose Repair/Reprocess.",
          datasetId: String(dataset.id),
        },
        { status: 502 },
      );
    }

    return Response.json(
      {
        jobId: String(job.id),
        fileId: String(created.id),
        datasetId: String(dataset.id),
        status: "queued",
        requiresUserChoice: false,
      },
      { status: 202 },
    );
  } catch (error: unknown) {
    payload.logger.error({ err: error }, "Upload failed.");

    return Response.json(
      {
        error: "Upload failed.",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
