import { inngest } from "./inngest";
import { getPayloadClient } from "./payload";
import {
  attemptSingleAiModel,
  buildDashboardGenerationPrompt,
  finalizeConfigUpgrade,
  parsedTablesFromNormalized,
  processIngestionDirectly,
} from "./directIngestion";
import { processDocumentIngestionDirectly } from "./directDocumentIngestion";
import type { NormalizedTableShape } from "@analytics/shared";

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

    // Phase A only: parse, build the fast fallback, validate, store, mark
    // the dataset ready -- no AI model call happens inside this
    // invocation at all anymore. The returned result is exactly what
    // Phase B (upgradeDatasetConfigFunction below) needs to run
    // independently, in its own invocation, on its own clock.
    const phaseA = await processIngestionDirectly(payload, jobId, datasetId, buffer, filename, intentPrompt);

    await inngest.send({
      name: "dataset/config-upgrade-requested",
      data: phaseA,
    });

    return { datasetId, jobId, status: "generating_config" };
  },
);

export type ConfigUpgradeRequestedEventData = {
  datasetId: string;
  jobId: string;
  filename: string;
  intentPrompt: string | null;
};

/**
 * Phase B of the async-upgrade architecture (see processIngestionDirectly's
 * own doc comment in directIngestion.ts for the full "why"): the actual AI
 * attempt, decoupled from the request/response path and from Phase A's
 * own invocation entirely. Triggered by the event Phase A sends once the
 * dataset is already ready with a working, validated fallback -- nothing
 * here is allowed to leave the dataset worse off than it already is if
 * every model attempt fails.
 *
 * Each model attempt is its own step.run() call. This is the part that
 * actually removes the platform duration ceiling from this path, not just
 * moves it: Inngest checkpoints after each step, so even if attempting
 * all 3 models plus one stricter retry took several minutes in total
 * (measured: ~352s end to end before this split existed), no single
 * invocation needs to stay alive for that whole span -- each step can run
 * as its own short-lived invocation if Inngest chooses to resume that way.
 *
 * IMPORTANT (unverified from this environment, flagged rather than
 * assumed): the exact per-step and per-function duration limits on this
 * Inngest account's own plan haven't been confirmed against the real
 * dashboard. The step.run() structure is correct regardless of what that
 * number turns out to be, but if steps are somehow still landing inside
 * one continuous invocation in practice, that's worth checking directly.
 */
export const upgradeDatasetConfigFunction = inngest.createFunction(
  { id: "upgrade-dataset-config", retries: 1, triggers: [{ event: "dataset/config-upgrade-requested" }] },
  async ({ event, step }) => {
    const { datasetId, jobId, filename, intentPrompt } =
      event.data as ConfigUpgradeRequestedEventData;

    const payload = await getPayloadClient();

    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      // No key configured -- there is genuinely nothing for this step to
      // do. Phase A's fallback stays exactly as it is; mark the job
      // completed so it doesn't sit at "generating_config" forever.
      await payload.update({ collection: "jobs", id: Number(jobId), data: { status: "completed" } });
      return { datasetId, jobId, status: "completed", upgraded: false, reason: "no_api_key" };
    }

    // Must be the tables Phase A already persisted -- never re-parse the
    // original file here. See parsedTablesFromNormalized's own doc
    // comment for exactly why re-parsing would be a real data-integrity
    // risk, not just wasted work.
    const dataset = await step.run("load-stored-tables", async () => {
      const ds = await payload.findByID({ collection: "datasets", id: datasetId, depth: 0 });
      const stored = (ds as any).data as { tables?: NormalizedTableShape[] } | null;
      return { tables: stored?.tables ?? [] };
    });

    if (dataset.tables.length === 0) {
      await payload.update({ collection: "jobs", id: Number(jobId), data: { status: "completed" } });
      return { datasetId, jobId, status: "completed", upgraded: false, reason: "no_stored_tables" };
    }

    const tables = parsedTablesFromNormalized(dataset.tables);
    const totalRows = tables.reduce((acc, t) => acc + t.rowCount, 0);
    const prompt = buildDashboardGenerationPrompt(tables, filename, totalRows, intentPrompt);

    // Reordered from Phase A's original list per this session's own
    // measured evidence, not a guess: across two real local runs against
    // the same multi-sheet file, anthropic/claude-sonnet-5 timed out at
    // 90s both times, while google/gemini-2.5-flash and openai/gpt-4o
    // each returned a real response well under 30s (both were rejected
    // for content reasons, not infrastructure ones). Kept sonnet FIRST
    // anyway -- it's presumably the highest-quality model when it does
    // respond, and "priority is accuracy" argues for giving it its shot
    // before the faster-but-observed-lower-effort alternatives, not for
    // dropping it. The timeout itself is still cut from 90s to 60s: a
    // response that hasn't arrived by then is far more likely stuck than
    // about to succeed, and Phase B no longer shares a clock with
    // anything user-facing, so this is about not burning a step
    // pointlessly, not about protecting a wait a person is watching.
    const modelsToTry = ["anthropic/claude-sonnet-5", "google/gemini-2.5-flash", "openai/gpt-4o"];

    let lastProblems: string[] = [];
    let candidate: any = null;

    for (const modelId of modelsToTry) {
      const result = await step.run(`attempt-model-${modelId}`, () =>
        attemptSingleAiModel(modelId, prompt, tables, apiKey, datasetId, 60000),
      );

      if (result.candidate) {
        candidate = result.candidate;
        break;
      }

      if (result.problems.length > 0) {
        lastProblems = result.problems;
      }
    }

    // No self-retry: unlike Phase A's original logic (which retried
    // modelsToTry[0] against itself), this uses a DIFFERENT model for the
    // stricter retry -- modelsToTry[0] is exactly the one already
    // observed timing out; retrying it with itself only guarantees paying
    // that same cost twice for no new chance of success. modelsToTry[1]
    // (gemini-2.5-flash) already proved it responds quickly in this
    // exact scenario.
    if (!candidate && lastProblems.length > 0 && modelsToTry[1]) {
      const stricterPrompt = [
        prompt,
        "",
        "Your previous response was rejected for these exact reasons:",
        ...lastProblems.map((problem) => `- ${problem}`),
        "Fix every one of these in your next response. Return ONLY the corrected JSON, matching the exact same schema as above.",
      ].join("\n");

      const retryResult = await step.run(`retry-model-${modelsToTry[1]}`, () =>
        attemptSingleAiModel(modelsToTry[1]!, stricterPrompt, tables, apiKey, datasetId, 60000),
      );

      if (retryResult.candidate) {
        candidate = retryResult.candidate;
      }
    }

    if (!candidate) {
      // Every model, plus the retry, failed or was rejected. Nothing
      // breaks: Phase A's fallback is already live and stays exactly as
      // it is. Mark the job completed -- there is no further attempt
      // scheduled, and an admin should never see "generating_config"
      // hang forever for a dataset that already has a working dashboard.
      await payload.update({ collection: "jobs", id: Number(jobId), data: { status: "completed" } });
      console.warn(
        `[UpgradeConfig] No model produced a valid upgrade for dataset ${datasetId}; the Phase A fallback remains the live config.`,
      );
      return { datasetId, jobId, status: "completed", upgraded: false, reason: "all_models_exhausted" };
    }

    const finalize = await step.run("finalize-upgrade", () =>
      finalizeConfigUpgrade(payload, datasetId, jobId, candidate, tables).catch((err: unknown) => ({
        error: err instanceof Error ? err.message : String(err),
      })),
    );

    if ("error" in finalize) {
      // The candidate passed findAiConfigProblems but failed the final
      // Zod-backed gate (the same one Phase A's own fallback goes
      // through) -- treat it the same as "no valid candidate": leave
      // Phase A's fallback in place, complete the job, log why.
      await payload.update({ collection: "jobs", id: Number(jobId), data: { status: "completed" } });
      console.warn(
        `[UpgradeConfig] Candidate for dataset ${datasetId} failed final validation, keeping the Phase A fallback: ${finalize.error}`,
      );
      return { datasetId, jobId, status: "completed", upgraded: false, reason: "final_validation_failed" };
    }

    console.log(
      `[UpgradeConfig] Dataset ${datasetId} upgraded to a real AI-generated config, version ${finalize.configVersion}.`,
    );

    return { datasetId, jobId, status: "completed", upgraded: true, configVersion: finalize.configVersion };
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
