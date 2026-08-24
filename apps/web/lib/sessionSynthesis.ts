import {
  buildDatasetMetadata,
  CONFIG_SOURCE,
  findHighCardinalityChartAxes,
  findUnresolvableMetrics,
  resolvedDashboardConfigSchema,
  resolveInsightMetrics,
  resolveSessionFindings,
  type DocumentSectionShape,
  type NormalizedTableShape,
  type ResolvedDashboardConfigShape,
  type ResolvedSessionFindingShape,
  type SessionDatasetSource,
  type SessionDocumentSource,
} from "@analytics/shared";
import type { Payload } from "payload";

import {
  CombinedDashboardValidationError,
  type ClaudeCombinedDashboardClient,
} from "./claudeCombinedDashboardClient";
import {
  type SessionSynthesisClient,
} from "./claudeSessionSynthesisClient";
import { invalidateCache } from "./cache";

/**
 * Phase B for combined sessions -- the AI-upgrade half of the same
 * Phase A/Phase B split datasets got (see directIngestion.ts's header and
 * lib/sessionFallback.ts for the other half). Everything here runs AFTER
 * POST /api/sessions has already returned, triggered by
 * inngestFunctions.ts's upgradeSessionOverviewFunction, each piece wrapped
 * in its own checkpointed step. Nothing in this file may leave the session
 * worse off than the deterministic fallback Phase A wrote: every AI
 * failure mode resolves to "keep whatever is live," never an overwrite
 * with less.
 *
 * The pieces are exported separately (not one monolithic run function)
 * because Inngest checkpoints BETWEEN them -- a combined-dashboard
 * generation that takes minutes must not have to rerun because the
 * findings call after it failed -- while scripts and tests can still call
 * runSessionSynthesis below for the whole sequence in one go.
 */

export type SessionSynthesisDeps = {
  payload: Payload;
  synthesisClient: SessionSynthesisClient;
  combinedDashboardClient: ClaudeCombinedDashboardClient;
  adminIntent?: string;
};

type StoredDatasetData = { tables?: NormalizedTableShape[]; relationships?: unknown[] };
type StoredDocumentData = { fullText?: string; sections?: DocumentSectionShape[] };

export type LoadedSessionSources = {
  datasetInputs: {
    datasetId: string;
    datasetName: string;
    metadata: unknown;
    tables: NormalizedTableShape[];
  }[];
  documentInputs: {
    documentId: string;
    documentName: string;
    fullText: string;
    sections: DocumentSectionShape[];
    keyPoints?: unknown[];
  }[];
  datasetSources: Map<string, SessionDatasetSource>;
  documentSources: Map<string, SessionDocumentSource>;
};

/**
 * Prompt 16.0 item 3: claudeCombinedDashboardClient.ts already validates
 * its own output against dashboardConfigSchema before returning, but that
 * is validation of the RAW (unresolved-metrics) shape, earlier in the
 * call chain than this file's own write. This function is the check
 * immediately before THIS write site's payload.update -- resolving
 * metrics could, in principle, produce a shape resolveDashboardConfigSchema
 * would reject even when the raw shape passed, and nothing before this
 * point actually confirms that. "Validated earlier in the chain" and
 * "validated right before this specific write" are different claims; this
 * codebase had exactly one write site (directIngestion.ts's initial
 * generation) where the first was quietly assumed to imply the second and
 * it did not. Throws a plain Error (not CombinedDashboardValidationError)
 * so a failure here logs and falls back gracefully via the existing catch
 * below, rather than triggering an unrelated retry path meant for the
 * client's own validation errors.
 */
const validateResolvedCombinedConfig = (
  candidate: ResolvedDashboardConfigShape,
): ResolvedDashboardConfigShape => {
  const check = resolvedDashboardConfigSchema.safeParse(candidate);

  if (!check.success) {
    throw new Error(
      `Resolved combined dashboard config failed schema validation immediately before storage: ${JSON.stringify(check.error.issues)}`,
    );
  }

  return check.data;
};

/**
 * Step 1 of the upgrade: read the session and its sources' ALREADY-STORED
 * data (never re-parse files -- same integrity rule as
 * parsedTablesFromNormalized). Returns null when the session doesn't exist
 * or has no usable stored material at all, in which case there is nothing
 * to upgrade and the caller leaves the session exactly as it is.
 */
export const loadSessionSynthesisSources = async (
  payload: Payload,
  sessionId: string,
): Promise<LoadedSessionSources | null> => {
  let session;

  try {
    session = await payload.findByID({ collection: "sessions", id: sessionId, depth: 0 });
  } catch {
    return null;
  }

  const relationshipIdsOf = (value: unknown): string[] => {
    if (!Array.isArray(value)) {
      return [];
    }

    return value.map((entry) =>
      typeof entry === "object" && entry !== null && "id" in entry
        ? String((entry as { id: unknown }).id)
        : String(entry),
    );
  };

  const datasetIds = relationshipIdsOf(session.datasets);
  const documentIds = relationshipIdsOf(session.documents);

  const datasetSources = new Map<string, SessionDatasetSource>();
  const datasetInputs: LoadedSessionSources["datasetInputs"] = [];

  for (const id of datasetIds) {
    let dataset;

    try {
      dataset = await payload.findByID({ collection: "datasets", id, depth: 0 });
    } catch {
      continue;
    }

    const stored = dataset.data as StoredDatasetData | null;
    const tables = stored?.tables ?? [];

    if (tables.length === 0) {
      continue;
    }

    datasetSources.set(id, { name: dataset.name, tables });
    datasetInputs.push({
      datasetId: id,
      datasetName: dataset.name,
      metadata: buildDatasetMetadata(id, dataset.name, tables, stored?.relationships ?? []),
      tables,
    });
  }

  const documentSources = new Map<string, SessionDocumentSource>();
  const documentInputs: LoadedSessionSources["documentInputs"] = [];

  for (const id of documentIds) {
    let document;

    try {
      document = await payload.findByID({ collection: "documents", id, depth: 0 });
    } catch {
      continue;
    }

    const stored = document.data as StoredDocumentData | null;
    const fullText = stored?.fullText;
    const sections = stored?.sections ?? [];

    if (!fullText || sections.length === 0) {
      continue;
    }

    let keyPoints: unknown[] = [];
    try {
      const summary = await payload.find({
        collection: "summaries",
        where: { document: { equals: id } },
        sort: "-version",
        limit: 1,
        depth: 0,
      });
      keyPoints = (summary.docs[0]?.keyPoints as unknown[]) ?? [];
    } catch {
      // Non-fatal
    }

    documentSources.set(id, { name: document.name, fullText, sections });
    documentInputs.push({
      documentId: id,
      documentName: document.name,
      fullText,
      sections,
      keyPoints,
    });
  }

  if (datasetInputs.length === 0 && documentInputs.length === 0) {
    return null;
  }

  return { datasetInputs, documentInputs, datasetSources, documentSources };
};

export type CombinedCandidateResult = {
  /** A fully validated, resolved combined dashboard config -- or null. */
  candidate: ResolvedDashboardConfigShape | null;
  /** Why no candidate resulted (logged by callers; never thrown). */
  reason?: string;
};

/**
 * Step 2 of the upgrade: the combined-dashboard AI attempt, including the
 * existing one-shot stricter retry on a validation rejection (the exact
 * behavior that used to run inside POST /api/sessions' 231-second request).
 * Never throws: every failure mode resolves to {candidate: null}, because
 * Phase A's fallback is already live and a single failed attempt is
 * routine, expected, and must never fail its wrapping step.
 *
 * Two checks added beyond what this path historically ran (both already
 * standard at every other config write site via directIngestion.ts's
 * shared gate): findHighCardinalityChartAxes and findUnresolvableMetrics
 * against the RAW candidate before metric resolution. These are precisely
 * the classes of defect observed in the field here -- haiku emitting
 * "distinct" as an insight-metric aggregation (valid for widgets, illegal
 * for metric references) and wrong-typed filter values -- so the upgrade
 * now rejects them itself instead of relying on downstream luck.
 */
export const generateCombinedCandidate = async (
  deps: Pick<SessionSynthesisDeps, "payload" | "combinedDashboardClient">,
  sources: LoadedSessionSources,
  adminIntent?: string,
): Promise<CombinedCandidateResult> => {
  const { payload, combinedDashboardClient } = deps;

  if (sources.datasetInputs.length === 0) {
    // Documents-only session: there are no tables to build a dashboard
    // from. Not a failure -- findings may still upgrade this session.
    return { candidate: null, reason: "no_dataset_tables" };
  }

  const allTables = sources.datasetInputs.flatMap((d) => d.tables);
  const primaryDatasetId = sources.datasetInputs[0]!.datasetId;

  const attempt = async (
    stricterInstruction?: string,
  ): Promise<ResolvedDashboardConfigShape> => {
    const rawConfig = await combinedDashboardClient.generateCombinedDashboard(
      sources.datasetInputs,
      sources.documentInputs,
      { adminIntent: adminIntent || undefined, stricterInstruction },
    );

    // The two extra pre-resolution checks described above. The client has
    // already schema-validated the raw shape; these catch the semantic
    // defects a bare schema pass cannot see.
    rawConfig.datasetId = primaryDatasetId;

    const chartAxisProblems = findHighCardinalityChartAxes(rawConfig as any, allTables as any);
    if (chartAxisProblems.length > 0) {
      throw new CombinedDashboardValidationError(
        `combined dashboard charts a near-unique column as a category axis: ${chartAxisProblems.join("; ")}`,
      );
    }

    const unresolvable = findUnresolvableMetrics(rawConfig.insights ?? [], allTables as any);
    if (unresolvable.length > 0) {
      throw new CombinedDashboardValidationError(
        `combined dashboard has insight metrics that don't resolve against real data: ${unresolvable.join("; ")}`,
      );
    }

    const resolvedInsights = resolveInsightMetrics(rawConfig.insights, allTables as any);
    return validateResolvedCombinedConfig({ ...rawConfig, insights: resolvedInsights });
  };

  try {
    return { candidate: await attempt() };
  } catch (configError: unknown) {
    if (configError instanceof CombinedDashboardValidationError) {
      payload.logger.info("Retrying combined dashboard generation with stricter instructions...");
      try {
        return { candidate: await attempt(configError.message) };
      } catch (retryError) {
        payload.logger.warn(`Combined retry failed: ${retryError}`);
        return { candidate: null, reason: "validation_failed_after_retry" };
      }
    }

    payload.logger.warn(
      `Combined dashboard config generation encountered error: ${configError instanceof Error ? configError.message : String(configError)}`,
    );
    return { candidate: null, reason: "generation_error" };
  }
};

export type FindingsResult = {
  /** Verified cross-source findings ([] when none were genuine). */
  findings: ResolvedSessionFindingShape[];
  /**
   * True when the attempt itself SUCCEEDED -- including the legitimate
   * empty-array outcome ("nothing real connects these sources"). Only a
   * false here means the model never produced anything usable.
   */
  ok: boolean;
};

/**
 * Step 3 of the upgrade: the cross-source findings attempt. Only ever
 * called when the session has at least one dataset AND one document --
 * sessionFindingSchema requires both sides of every finding, so any other
 * composition has nothing for this step to look for. Never throws.
 */
export const synthesizeFindings = async (
  deps: Pick<SessionSynthesisDeps, "payload" | "synthesisClient">,
  sources: LoadedSessionSources,
): Promise<FindingsResult> => {
  const { payload, synthesisClient } = deps;

  if (sources.datasetInputs.length === 0 || sources.documentInputs.length === 0) {
    return { findings: [], ok: true };
  }

  try {
    const rawSynthesis = await synthesisClient.synthesize(
      sources.datasetInputs,
      sources.documentInputs,
    );
    const { resolved } = resolveSessionFindings(
      rawSynthesis.findings,
      sources.datasetSources,
      sources.documentSources,
    );
    return { findings: resolved, ok: true };
  } catch (error: unknown) {
    // Synthesis citation pairing is secondary; do not block the upgrade on
    // it. Logged, not swallowed silently.
    payload.logger.warn(
      `Cross-source findings synthesis failed (keeping existing findings): ${error instanceof Error ? error.message : String(error)}`,
    );
    return { findings: [], ok: false };
  }
};

/**
 * Step 4 of the upgrade: the ONLY write in this file. Spreads the
 * session's current overview so an upgrade that produced just findings
 * keeps the fallback config (and vice versa), stamps configSource so the
 * frontend stops polling, renames the session from the config title when
 * there is one, and clears the server-side cache. Called only when at
 * least one genuine improvement exists -- a total AI failure reaches the
 * "no-op" branch in the orchestrators instead, leaving Phase A's fallback
 * byte-for-byte untouched.
 */
export const finalizeSessionUpgrade = async (
  payload: Payload,
  sessionId: string,
  upgrade: { config: ResolvedDashboardConfigShape | null; findings: ResolvedSessionFindingShape[] },
): Promise<void> => {
  let session;

  try {
    session = await payload.findByID({ collection: "sessions", id: sessionId, depth: 0 });
  } catch {
    // Session vanished mid-upgrade (deleted by the admin): nothing to write.
    return;
  }

  const currentOverview =
    session.overview && typeof session.overview === "object"
      ? (session.overview as Record<string, unknown>)
      : {};

  const nextOverview: Record<string, unknown> = {
    ...currentOverview,
    findings: upgrade.findings,
    configSource: CONFIG_SOURCE.initialAutoGeneration,
  };

  if (upgrade.config) {
    nextOverview.config = upgrade.config;
  }

  const data: Record<string, unknown> = {
    status: "ready",
    overview: nextOverview,
  };

  if (upgrade.config?.title) {
    data.name = upgrade.config.title;
  }

  await payload.update({
    collection: "sessions",
    id: sessionId,
    data: data as any,
  });

  invalidateCache("session");
};

export type SessionSynthesisResult =
  | {
      ok: true;
      sessionId: string;
      /** True when something genuinely improved; false means the fallback stays. */
      upgraded: boolean;
      reason?: string;
      config: ResolvedDashboardConfigShape | null;
      findings: ResolvedSessionFindingShape[];
    }
  | { ok: false; status: number; error: string };

/**
 * The whole Phase B sequence in one call, without Inngest step
 * checkpointing -- the convenience form scripts (verify-combined-session.ts)
 * and tests use. The Inngest function composes the four exported pieces
 * above with step.run() instead, for exactly the checkpointing reasons in
 * this file's header. Never throws for AI failures: they resolve to
 * {upgraded: false}; only a missing session returns ok:false (404).
 */
export const runSessionSynthesis = async (
  sessionId: string,
  deps: SessionSynthesisDeps,
): Promise<SessionSynthesisResult> => {
  const sources = await loadSessionSynthesisSources(deps.payload, sessionId);

  if (!sources) {
    return { ok: false, status: 404, error: "Session not found." };
  }

  const { candidate, reason: configReason } = await generateCombinedCandidate(
    deps,
    sources,
    deps.adminIntent,
  );

  const { findings, ok: findingsOk } = await synthesizeFindings(deps, sources);

  const hasGenuineImprovement = Boolean(candidate) || (findingsOk && findings.length > 0);

  if (!hasGenuineImprovement) {
    // Every AI attempt failed (or legitimately found nothing): Phase A's
    // deterministic fallback stays exactly as it is. This is the branch
    // that used to write the empty overview -- it no longer writes anything.
    return {
      ok: true,
      sessionId,
      upgraded: false,
      reason: configReason ?? "no_ai_output",
      config: null,
      findings: [],
    };
  }

  await finalizeSessionUpgrade(deps.payload, sessionId, {
    config: candidate,
    findings: findingsOk ? findings : [],
  });

  return {
    ok: true,
    sessionId,
    upgraded: true,
    config: candidate,
    findings: findingsOk ? findings : [],
  };
};