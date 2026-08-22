import { inngest } from "./inngest";
import { getPayloadClient } from "./payload";
import { processIngestionDirectly } from "./directIngestion";
import { processDocumentIngestionDirectly } from "./directDocumentIngestion";

export type DatasetUploadedEventData = {
  jobId: string;
  datasetId: string;
  fileId: string;
  filename: string;
  intentPrompt?: string | null;
};

/**
 * Runs the exact same processIngestionDirectly logic (parsing, AI
 * generation with all of today's validation/grounding/retry fixes,
 * dataset lock, session wrap) that previously ran synchronously inside
 * the /api/uploads request. The only thing that changes is who calls it
 * and when: Inngest invokes this as a durable background job instead of
 * the HTTP request blocking on it, with its own retry on an uncaught
 * failure.
 *
 * The event carries only ids, never the file's bytes -- a 25 MB upload
 * would sit uncomfortably close to (or over) typical event-payload size
 * limits, and there's no need: Files.dataBase64 (kept specifically
 * because local disk storage doesn't persist across serverless
 * invocations) already gives this function everything it needs to
 * reconstruct the buffer, the same way the reprocess route already does.
 */
export const ingestDatasetFunction = inngest.createFunction(
  { id: "ingest-dataset", retries: 2, triggers: [{ event: "dataset/uploaded" }] },
  async ({ event }) => {
    const { jobId, datasetId, fileId, filename, intentPrompt } =
      event.data as DatasetUploadedEventData;

    const payload = await getPayloadClient();

    const fileRecord = await payload.findByID({
      collection: "files",
      id: fileId,
      depth: 0,
    });

    const dataBase64 = (fileRecord as any).dataBase64 as string | undefined;

    if (!dataBase64) {
      throw new Error(
        `File ${fileId} has no dataBase64 stored -- cannot reconstruct its bytes to ingest.`,
      );
    }

    const buffer = Buffer.from(dataBase64, "base64");

    await processIngestionDirectly(payload, jobId, datasetId, buffer, filename, intentPrompt);

    return { datasetId, jobId, status: "completed" };
  },
);

export type DocumentUploadedEventData = {
  jobId: string;
  documentId: string;
  fileId: string;
  fileHash: string;
  intentPrompt?: string | null;
};

/**
 * The document-side counterpart to ingestDatasetFunction above, running
 * directDocumentIngestion.ts's processDocumentIngestionDirectly (ported
 * from worker/src/processors/documentIngestion.ts) as a durable Inngest
 * job instead of the BullMQ+Redis path documents previously used
 * exclusively. Removes the last Redis dependency for job processing on
 * this deployment -- the earlier Inngest migration only covered datasets,
 * deliberately deferring this because the extraction logic lived only in
 * the worker package; it's ported into apps/web now (geminiDocument.ts,
 * claudeDocumentSummary.ts, documentDetector.ts) so this function has
 * something to call.
 */
export const ingestDocumentFunction = inngest.createFunction(
  { id: "ingest-document", retries: 2, triggers: [{ event: "document/uploaded" }] },
  async ({ event }) => {
    const { jobId, documentId, fileId, fileHash, intentPrompt } =
      event.data as DocumentUploadedEventData;

    const payload = await getPayloadClient();

    await processDocumentIngestionDirectly(
      payload,
      jobId,
      documentId,
      fileId,
      fileHash,
      intentPrompt,
    );

    return { documentId, jobId, status: "completed" };
  },
);
