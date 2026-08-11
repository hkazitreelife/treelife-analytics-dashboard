import { requireUser } from "@/lib/auth";
import { enqueueIngestion } from "@/lib/queue";
import {
  baseNameWithoutExtension,
  maxUploadBytes,
  resolveFileType,
  sha256,
  supportedExtensions,
} from "@/lib/uploads";

export const runtime = "nodejs";

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

  try {
    const duplicate = await payload.find({
      collection: "files",
      where: { sha256: { equals: hash } },
      limit: 1,
      depth: 0,
    });

    const duplicateFile = duplicate.docs[0];

    if (duplicateFile) {
      const owningDataset = await payload.find({
        collection: "datasets",
        where: { currentFileHash: { equals: hash } },
        limit: 1,
        depth: 0,
      });

      return Response.json(
        {
          status: "duplicate_noop",
          fileId: String(duplicateFile.id),
          existingDatasetId: owningDataset.docs[0]
            ? String(owningDataset.docs[0].id)
            : null,
          message: "File already processed.",
        },
        { status: 200 },
      );
    }

    const created = await payload.create({
      collection: "files",
      data: {
        sha256: hash,
        uploadedBy: user.id,
      },
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
      },
    });

    await enqueueIngestion({
      jobId: String(job.id),
      fileId: String(created.id),
      datasetId: String(dataset.id),
      fileHash: hash,
    });

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
