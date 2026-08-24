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
import { createClaudeCombinedDashboardClient } from "./claudeCombinedDashboardClient";
import { createSessionSynthesisClient } from "./claudeSessionSynthesisClient";
import {
  finalizeSessionUpgrade,
  generateCombinedCandidate,
  loadSessionSynthesisSources,
  synthesizeFindings,
  type LoadedSessionSources,
} from "./sessionSynthesis";
import type {
  NormalizedTableShape,
  ResolvedDashboardConfigShape,
  ResolvedSessionFindingShape,
} from "@analytics/shared";

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

export type SessionSynthesisRequestedEventData = {
  sessionId: string;
  adminIntent?: string | null;
};

/**
 * Rebuilds the in-memory Maps of LoadedSessionSources from the
 * JSON-serializable subset an earlier step returned. Needed because
 * Inngest checkpoints step results by serializing them, and a Map does
 * not survive that round-trip -- so the load step deliberately returns
 * only the plain input arrays, and every later step that needs lookup
 * maps reconstructs them here. Purely mechanical: same entries, same keys.
 */
const rebuildSources = (
  inputs: Pick<LoadedSessionSources, "datasetInputs" | "documentInputs">,
): LoadedSessionSources => ({
  ...inputs,
  datasetSources: new Map(
    inputs.datasetInputs.map((d) => [
      d.datasetId,
      { name: d.datasetName, tables: d.tables },
    ]),
  ),
  documentSources: new Map(
    inputs.documentInputs.map((d) => [
      d.documentId,
      { name: d.documentName, fullText: d.fullText, sections: d.sections },
    ]),
  ),
});

/**
 * Phase B for combined sessions -- the exact architectural counterpart of
 * upgradeDatasetConfigFunction above, extended to the session/multi-source
 * path. Triggered by the event POST /api/sessions sends AFTER it has
 * already written the deterministic fallback overview and returned to the
 * admin (see lib/sessionFallback.ts): by the time this runs, the session
 * is ready with something real on screen, and nothing here shares a clock
 * with any HTTP request.
 *
 * Each phase is its own step.run() for the same checkpointing reason the
 * dataset upgrade documents above: the combined-dashboard generation alone
 * was measured taking minutes when its model truncated mid-response and a
 * retry followed -- previously all inside ONE synchronous HTTP request
 * (231s measured end to end). Now no single step needs to outlive one AI
 * call, and a crash between steps resumes from the last checkpoint instead
 * of redoing paid work.
 *
 * Failure posture mirrors the dataset upgrade exactly: if every AI attempt
 * fails or produces nothing genuine, NOTHING is written -- Phase A's
 * validated fallback remains the live overview, and the run completes
 * successfully with upgraded:false. There is no state in which this
 * function leaves a session emptier than it found it.
 */
export const upgradeSessionOverviewFunction = inngest.createFunction(
  {
    id: "upgrade-session-overview",
    retries: 1,
    triggers: [{ event: "session/synthesis-requested" }],
  },
  async ({ event, step }) => {
    const { sessionId, adminIntent } = event.data as SessionSynthesisRequestedEventData;

    const payload = await getPayloadClient();

    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      // No key configured -- genuinely nothing to do. The fallback stays;
      // there is no job row to hang at "generating_config" here because
      // sessions never had one.
      return { sessionId, status: "completed", upgraded: false, reason: "no_api_key" };
    }

    // Step 1: read the session's already-stored sources. Returns ONLY the
    // JSON-serializable inputs (Maps stripped -- see rebuildSources above).
    const loaded = await step.run("load-session-sources", async () => {
      const sources = await loadSessionSynthesisSources(payload, sessionId);

      if (!sources) {
        return null;
      }

      return {
        datasetInputs: sources.datasetInputs,
        documentInputs: sources.documentInputs,
      };
    });

    if (!loaded) {
      return {
        sessionId,
        status: "completed",
        upgraded: false,
        reason: "no_usable_sources",
      };
    }

    const synthesisClient = createSessionSynthesisClient(apiKey);
    const combinedDashboardClient = createClaudeCombinedDashboardClient(apiKey);

    // Step 2: the combined-dashboard attempt (with its stricter retry),
    // checkpointed independently of the findings call below.
    const candidateResult = await step.run(
      "generate-combined-dashboard-candidate",
      () =>
        generateCombinedCandidate(
          { payload, combinedDashboardClient },
          rebuildSources(loaded),
          adminIntent ?? undefined,
        ),
    );

    // Step 3: cross-source findings. Skips itself harmlessly (ok:true,
    // empty) when the session lacks the dataset+document pairing the
    // findings contract requires.
    const findingsResult = await step.run("synthesize-cross-source-findings", () =>
      synthesizeFindings({ payload, synthesisClient }, rebuildSources(loaded)),
    );

    const hasGenuineImprovement =
      Boolean(candidateResult.candidate) ||
      (findingsResult.ok && findingsResult.findings.length > 0);

    if (!hasGenuineImprovement) {
      console.warn(
        `[UpgradeSession] No usable AI output for session ${sessionId} (${candidateResult.reason ?? "findings_empty"}); the deterministic fallback remains the live overview.`,
      );
      return {
        sessionId,
        status: "completed",
        upgraded: false,
        reason: candidateResult.reason ?? "no_ai_output",
      };
    }

    // Step 4: the only write. Preserves whichever half (config/findings)
    // the attempts didn't improve, stamps configSource so the frontend
    // stops polling, and clears the server-side cache.
    //
    // The casts through unknown are deliberate, not sloppiness: Inngest
    // checkpoints each step's return value by serializing it to JSON, so
    // TypeScript types what comes back as a Jsonified view of the schema
    // (optional properties widened to `| undefined`). At runtime the
    // objects ARE the same JSON structures the schemas describe -- and
    // JSON is exactly what Payload stores -- so handing them to
    // finalizeSessionUpgrade under their real schema types is sound.
    const upgradedConfig = candidateResult.candidate
      ? (candidateResult.candidate as unknown as ResolvedDashboardConfigShape)
      : null;
    const upgradedFindings = findingsResult.ok
      ? (findingsResult.findings as unknown as ResolvedSessionFindingShape[])
      : [];

    await step.run("finalize-session-upgrade", () =>
      finalizeSessionUpgrade(payload, sessionId, {
        config: upgradedConfig,
        findings: upgradedFindings,
      }),
    );

    console.log(`[UpgradeSession] Session ${sessionId} overview upgraded past its fallback.`);

    return { sessionId, status: "completed", upgraded: true };
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
