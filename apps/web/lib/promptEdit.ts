import {
  buildDatasetMetadata,
  CONFIG_SOURCE,
  dashboardConfigSchema,
  findUnknownReferences,
  type DashboardConfigShape,
  type DatasetEventType,
  type NormalizedTableShape,
} from "@analytics/shared";
import type { Payload } from "payload";

import {
  ClaudeEditBillingError,
  ClaudeEditValidationError,
  type ClaudeConfigEditClient,
} from "./claudeConfigEditClient";

/**
 * Section 13.3's editing flow, factored out of the route handler so it can
 * be exercised directly with a stubbed editClient (no real Claude call, no
 * real spend) — the same testability pattern worker/src/processors/
 * ingestion.ts's processIngestionJob already uses for its acceptance
 * scripts.
 */

const MAX_PROMPT_LENGTH = 2000;

export type PromptEditDeps = {
  payload: Payload;
  editClient: ClaudeConfigEditClient;
  publishEvent: (
    event: DatasetEventType,
    datasetId: string,
    jobId: string | null,
  ) => Promise<void>;
};

export type PromptEditResult =
  | { ok: true; datasetId: string; configVersion: number }
  | { ok: false; status: number; error: string };

type StoredDatasetData = {
  tables?: NormalizedTableShape[];
  relationships?: unknown[];
};

/** Only a validation-class failure earns the one stricter retry. */
const isOutputQualityFailure = (error: unknown): boolean =>
  error instanceof ClaudeEditValidationError;

export const runPromptEdit = async (
  datasetId: string,
  prompt: string,
  editedByUserId: number,
  deps: PromptEditDeps,
): Promise<PromptEditResult> => {
  const { payload, editClient, publishEvent } = deps;

  const trimmedPrompt = prompt.trim();

  if (trimmedPrompt.length === 0) {
    return { ok: false, status: 400, error: "prompt must not be empty." };
  }

  if (trimmedPrompt.length > MAX_PROMPT_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: `prompt must be ${MAX_PROMPT_LENGTH} characters or fewer.`,
    };
  }

  let dataset;

  try {
    dataset = await payload.findByID({
      collection: "datasets",
      id: datasetId,
      depth: 0,
    });
  } catch {
    return { ok: false, status: 404, error: "Dataset not found." };
  }

  const stored = dataset.data as StoredDatasetData | null;
  const tables = stored?.tables ?? [];

  if (tables.length === 0) {
    return {
      ok: false,
      status: 409,
      error: "This dataset has no stored data yet. Nothing to edit.",
    };
  }

  const latestConfigs = await payload.find({
    collection: "configs",
    where: { dataset: { equals: Number(datasetId) } },
    limit: 1,
    depth: 0,
    sort: "-version,-createdAt",
  });

  const currentConfigRecord = latestConfigs.docs[0];

  if (!currentConfigRecord) {
    return {
      ok: false,
      status: 404,
      error:
        "No dashboard config exists for this dataset yet. Nothing to edit.",
    };
  }

  const currentConfig = currentConfigRecord.config as DashboardConfigShape;
  const metadata = buildDatasetMetadata(
    String(datasetId),
    dataset.name,
    tables,
    stored?.relationships ?? [],
  );

  const attempt = async (
    stricterInstruction?: string,
  ): Promise<DashboardConfigShape> =>
    editClient.editConfig(
      currentConfig,
      metadata,
      tables,
      trimmedPrompt,
      stricterInstruction ? { stricterInstruction } : undefined,
    );

  let edited: DashboardConfigShape;

  try {
    edited = await attempt();
  } catch (firstError: unknown) {
    if (!isOutputQualityFailure(firstError)) {
      if (firstError instanceof ClaudeEditBillingError) {
        return { ok: false, status: 503, error: firstError.message };
      }

      return {
        ok: false,
        status: 502,
        error:
          firstError instanceof Error ? firstError.message : String(firstError),
      };
    }

    const violation =
      firstError instanceof Error ? firstError.message : String(firstError);

    payload.logger.warn(
      `Prompt edit failed validation, retrying once with stricter instruction on model "${editClient.retryModelName}". Violation: ${violation}`,
    );

    const stricter = [
      `The exact violation was: ${violation}`,
      "Return the complete config object -- every tab, widget and insight that",
      "should still exist -- not a diff and not only the changed fields.",
      "datasetId must be returned exactly as given in the metadata.",
      "Every sourceTable must be a table name from the metadata, verbatim, and",
      "every entry in fields must be a column that exists in that table,",
      "verbatim. Call emit_dashboard_config exactly once.",
    ].join(" ");

    try {
      edited = await attempt(stricter);
    } catch (secondError: unknown) {
      if (secondError instanceof ClaudeEditBillingError) {
        return { ok: false, status: 503, error: secondError.message };
      }

      const detail =
        secondError instanceof Error
          ? secondError.message
          : String(secondError);

      // Nothing is written on a second failure -- this returns before any
      // payload.create call.
      return {
        ok: false,
        status: 502,
        error: `Prompt edit failed validation twice, second attempt used model "${editClient.retryModelName}". First violation: ${violation} Second failure: ${detail}`,
      };
    }
  }

  /**
   * Validated once already inside editClient.editConfig; validated again
   * here, immediately before the Configs write, so nothing invalid can
   * reach storage regardless of which client implementation produced it —
   * the same deliberate duplication worker/src/processors/ingestion.ts uses
   * for the initial-generation path.
   */
  const revalidated = dashboardConfigSchema.safeParse(edited);

  if (!revalidated.success) {
    return {
      ok: false,
      status: 502,
      error: `Edited config failed re-validation before storage: ${JSON.stringify(revalidated.error.issues)}`,
    };
  }

  if (revalidated.data.datasetId !== String(datasetId)) {
    return {
      ok: false,
      status: 502,
      error: "Edited config changed datasetId; rejected before storage.",
    };
  }

  const unknownReferences = findUnknownReferences(revalidated.data, tables);

  if (unknownReferences.length > 0) {
    return {
      ok: false,
      status: 502,
      error: `Edited config references names absent from the dataset: ${unknownReferences.join("; ")}`,
    };
  }

  // Version is never hardcoded, same query worker/src/processors/
  // ingestion.ts uses: max existing version for this dataset, + 1.
  const priorConfigs = await payload.find({
    collection: "configs",
    where: { dataset: { equals: Number(datasetId) } },
    limit: 1,
    depth: 0,
    sort: "-version",
  });
  const nextVersion = (priorConfigs.docs[0]?.version ?? 0) + 1;

  await payload.create({
    collection: "configs",
    data: {
      dataset: Number(datasetId),
      version: nextVersion,
      config: revalidated.data,
      insights: revalidated.data.insights,
      generatedBy: CONFIG_SOURCE.promptEdit,
      editedBy: editedByUserId,
    },
  });

  await publishEvent("config.updated", String(datasetId), null);

  return { ok: true, datasetId: String(datasetId), configVersion: nextVersion };
};
