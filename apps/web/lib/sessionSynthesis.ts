import {
  buildDatasetMetadata,
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
  CombinedDashboardBillingError,
  CombinedDashboardValidationError,
  type ClaudeCombinedDashboardClient,
} from "./claudeCombinedDashboardClient";
import {
  SessionSynthesisBillingError,
  SessionSynthesisValidationError,
  type SessionSynthesisClient,
} from "./claudeSessionSynthesisClient";

export type SessionSynthesisDeps = {
  payload: Payload;
  synthesisClient: SessionSynthesisClient;
  combinedDashboardClient: ClaudeCombinedDashboardClient;
  adminIntent?: string;
};

export type SessionSynthesisResult =
  | {
      ok: true;
      sessionId: string;
      config?: ResolvedDashboardConfigShape;
      findings: ResolvedSessionFindingShape[];
    }
  | { ok: false; status: number; error: string };

type StoredDatasetData = { tables?: NormalizedTableShape[]; relationships?: unknown[] };
type StoredDocumentData = { fullText?: string; sections?: DocumentSectionShape[] };

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

const relationshipIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) =>
    typeof entry === "object" && entry !== null && "id" in entry
      ? String((entry as { id: unknown }).id)
      : String(entry),
  );
};

export const runSessionSynthesis = async (
  sessionId: string,
  deps: SessionSynthesisDeps,
): Promise<SessionSynthesisResult> => {
  const { payload, synthesisClient, combinedDashboardClient, adminIntent } = deps;

  let session;

  try {
    session = await payload.findByID({ collection: "sessions", id: sessionId, depth: 0 });
  } catch {
    return { ok: false, status: 404, error: "Session not found." };
  }

  const datasetIds = relationshipIds(session.datasets);
  const documentIds = relationshipIds(session.documents);

  const writeEmpty = async (): Promise<SessionSynthesisResult> => {
    await payload.update({
      collection: "sessions",
      id: sessionId,
      data: { status: "ready", overview: { findings: [] } },
    });

    return { ok: true, sessionId, findings: [] };
  };

  if (datasetIds.length === 0 && documentIds.length === 0) {
    return writeEmpty();
  }

  const datasetSources = new Map<string, SessionDatasetSource>();
  const datasetInputs: {
    datasetId: string;
    datasetName: string;
    metadata: unknown;
    tables: NormalizedTableShape[];
  }[] = [];

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
  const documentInputs: {
    documentId: string;
    documentName: string;
    fullText: string;
    sections: DocumentSectionShape[];
    keyPoints?: unknown[];
  }[] = [];

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
    return writeEmpty();
  }

  const allTables = datasetInputs.flatMap((d) => d.tables);

  let resolvedConfig: ResolvedDashboardConfigShape | undefined;
  if (datasetInputs.length > 0) {
    try {
      const rawConfig = await combinedDashboardClient.generateCombinedDashboard(
        datasetInputs,
        documentInputs,
        { adminIntent: adminIntent || session.name },
      );

      const resolvedInsights = resolveInsightMetrics(rawConfig.insights, allTables);
      resolvedConfig = validateResolvedCombinedConfig({ ...rawConfig, insights: resolvedInsights });
    } catch (configError: unknown) {
      if (configError instanceof CombinedDashboardValidationError) {
        payload.logger.info(`Retrying combined dashboard generation with stricter instructions...`);
        try {
          const rawConfig = await combinedDashboardClient.generateCombinedDashboard(
            datasetInputs,
            documentInputs,
            { adminIntent: adminIntent || session.name, stricterInstruction: configError.message },
          );
          const resolvedInsights = resolveInsightMetrics(rawConfig.insights, allTables);
          resolvedConfig = validateResolvedCombinedConfig({ ...rawConfig, insights: resolvedInsights });
        } catch (retryError) {
          payload.logger.warn(`Combined retry failed: ${retryError}`);
        }
      } else {
        payload.logger.warn(
          `Combined dashboard config generation encountered error: ${configError instanceof Error ? configError.message : String(configError)}`,
        );
      }
    }
  }

  let resolvedFindings: ResolvedSessionFindingShape[] = [];
  if (datasetInputs.length > 0 && documentInputs.length > 0) {
    try {
      const rawSynthesis = await synthesisClient.synthesize(datasetInputs, documentInputs);
      const { resolved } = resolveSessionFindings(
        rawSynthesis.findings,
        datasetSources,
        documentSources,
      );
      resolvedFindings = resolved;
    } catch {
      // Synthesis citation pairing is secondary; do not block dashboard
    }
  }

  const generatedName =
    resolvedConfig?.title ||
    (adminIntent && adminIntent.length <= 40 ? adminIntent : "Executive Overview");

  await payload.update({
    collection: "sessions",
    id: sessionId,
    data: {
      name: generatedName,
      status: "ready",
      overview: {
        config: resolvedConfig,
        findings: resolvedFindings,
      },
    },
  });

  return {
    ok: true,
    sessionId,
    config: resolvedConfig,
    findings: resolvedFindings,
  };
};
