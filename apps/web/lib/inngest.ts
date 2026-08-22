import { Inngest } from "inngest";

/**
 * Replaces BullMQ+Redis as the dataset-ingestion job queue. Inngest runs as
 * a managed service that calls back into this Next.js app's own
 * /api/inngest route to execute a function -- no separate persistent
 * worker process, no Redis, no job-queue quota to hit. This is what
 * finally lets the upload route go back to the documented design ("upload
 * creates File + Job records and returns 202 immediately, never blocking
 * on an AI call") without needing directIngestion.ts's synchronous-call
 * compromise for the trigger itself, even though the ingestion logic it
 * calls is unchanged.
 */
export const inngest = new Inngest({ id: "treelife-analytics" });
