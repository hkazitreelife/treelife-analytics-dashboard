import { z } from "zod";

import { requireUser } from "@/lib/auth";
import { enqueueIngestion } from "@/lib/queue";
import { baseNameWithoutExtension } from "@/lib/uploads";

export const runtime = "nodejs";

const confirmSchema = z.object({
  fileId: z.string().min(1),
  existingDatasetId: z.string().min(1),
  choice: z.enum(["update_existing", "create_new"]),
});

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

  const { fileId, existingDatasetId, choice } = parsed.data;

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

    let datasetId: number;

    if (choice === "update_existing") {
      // The existing dataset keeps its data until the new parse validates.
      const existing = await payload.update({
        collection: "datasets",
        id: existingDatasetId,
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
