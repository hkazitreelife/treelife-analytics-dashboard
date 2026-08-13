import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONFIG_SOURCE,
  dashboardConfigSchema,
  findExtraTabWidgets,
  findUnresolvableMetrics,
  readIngestionLimits,
  resolveInsightMetrics,
  resolvedDashboardConfigSchema,
  type DashboardConfigShape,
  type IngestionJobData,
  type NormalizedDatasetShape,
  type NormalizedTableShape,
  type ResolvedDashboardConfigShape,
} from "@analytics/shared";
import type { Queue } from "bullmq";
import type { Payload } from "payload";

import {
  buildDatasetMetadata,
  ClaudeBillingError,
  ClaudeValidationError,
  findUnknownReferences,
  type ClaudeConfigClient,
} from "../services/claudeConfig";

import { type DatasetLock } from "../services/datasetLock";
import { type DatasetEventPublisher } from "../services/events";
import {
  GeminiBillingError,
  GeminiValidationError,
  type GeminiClient,
} from "../services/gemini";
import {
  mergeDataset,
  MergeError,
  type MergeResult,
} from "../services/mergeDataset";
import {
  EmptyFileError,
  LimitExceededError,
  parseSpreadsheet,
  resolveDeterministicType,
  UnsupportedFileTypeError,
  type ParsedFile,
} from "../services/spreadsheetParser";

/**
 * The ingestion pipeline. Order matters: deterministic parsing and limit checks
 * happen before any AI call, so an oversized or unsupported file never costs a
 * model request. Nothing is written to the Dataset until the merged result has
 * passed schema validation.
 */

export class IngestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestionError";
  }
}

// fileURLToPath, not URL.pathname: the latter leaves percent-encoding in place,
// which breaks any path containing a space.
const MEDIA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../apps/web/media",
);

/**
 * Whether a failure was about the shape of the model's output, which is the only
 * kind a retry against a stronger model can fix.
 *
 * GeminiValidationError covers empty, non-JSON and schema-violating responses.
 * MergeError covers structural mismatches found while merging: a missing table,
 * a missing column index, or a headerRowIndex out of bounds. Everything else,
 * notably GeminiBillingError, network failures and invalid keys, is not.
 */
export const isOutputQualityFailure = (error: unknown): boolean =>
  error instanceof GeminiValidationError ||
  error instanceof MergeError ||
  error instanceof ClaudeValidationError;

export type IngestionDeps = {
  payload: Payload;
  gemini: GeminiClient;
  claude: ClaudeConfigClient;
  datasetLock: DatasetLock;
  queue: Queue<IngestionJobData>;
  events: DatasetEventPublisher;
  mediaDir?: string;
};

/**
 * How long a lock-contention requeue waits before the worker tries this job
 * again. Comfortably shorter than LOCK_TTL_MS (5 minutes), so a dataset whose
 * other job finishes quickly doesn't sit needlessly delayed, but long enough
 * not to hammer the queue with retries for a job that's likely still running.
 */
const LOCK_RETRY_DELAY_MS = 20_000;

const loadFileBytes = async (
  mediaDir: string,
  filename: string,
): Promise<Buffer> => {
  try {
    return await readFile(path.join(mediaDir, filename));
  } catch (error: unknown) {
    throw new IngestionError(
      `Stored file "${filename}" could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

/**
 * Runs Gemini, then merge and validate. On validation failure the model is
 * retried exactly once with a stricter instruction naming the exact violation.
 */
const inferAndMerge = async (
  gemini: GeminiClient,
  parsed: ParsedFile,
  datasetId: string,
  sourceFile: NormalizedDatasetShape["sourceFile"],
  logger: Payload["logger"],
): Promise<MergeResult> => {
  const attempt = async (
    stricterInstruction?: string,
  ): Promise<MergeResult> => {
    const metadata = await gemini.inferMetadata(
      parsed,
      stricterInstruction ? { stricterInstruction } : undefined,
    );

    return mergeDataset({ datasetId, sourceFile, parsed, metadata });
  };

  try {
    return await attempt();
  } catch (firstError: unknown) {
    // Escalating to a stronger, paid model only makes sense when the problem was
    // the shape of the output. A billing rejection, a dead network or a bad key
    // would fail identically on the retry and cost money to confirm it.
    if (!isOutputQualityFailure(firstError)) {
      if (firstError instanceof GeminiBillingError) {
        // Stored verbatim: no retry or validation framing, because neither
        // happened.
        throw firstError;
      }

      throw new IngestionError(
        `First-call failure, no retry attempted: ${
          firstError instanceof Error ? firstError.message : String(firstError)
        }`,
      );
    }

    const violation =
      firstError instanceof Error ? firstError.message : String(firstError);

    logger.warn(
      `Metadata failed validation, retrying once with stricter instruction on model "${gemini.retryModelName || "unset, fell back to the primary model"}". Violation: ${violation}`,
    );

    const stricter = [
      `The exact schema violation was: ${violation}`,
      "Return one entry per table, using the exact tableName strings supplied in",
      "the input, verbatim. Return one entry for every column index from 0 to",
      "width-1. headerRowIndex must be a valid zero-indexed row position within",
      "that table's rows. Every field in the response schema is required.",
      "Return JSON only.",
    ].join(" ");

    // A second failure is final. The job fails loudly rather than storing
    // partially valid output.
    try {
      return await attempt(stricter);
    } catch (secondError: unknown) {
      const detail =
        secondError instanceof Error
          ? secondError.message
          : String(secondError);

      if (secondError instanceof GeminiBillingError) {
        throw secondError;
      }

      throw new IngestionError(
        `Validation failed twice, second attempt used GEMINI_RETRY_MODEL "${gemini.retryModelName || "unset, fell back to the primary model"}". First violation: ${violation} Second failure: ${detail}`,
      );
    }
  }
};

/**
 * Config generation, with the same error-type discipline as the Gemini step: a
 * schema or reference violation earns one stronger retry, a request or billing
 * failure fails fast.
 */
const generateConfig = async (
  claude: ClaudeConfigClient,
  datasetId: string,
  datasetName: string,
  tables: NormalizedTableShape[],
  relationships: unknown[],
  logger: Payload["logger"],
): Promise<ResolvedDashboardConfigShape> => {
  // Rows are read only to compute aggregates; only aggregates leave this call.
  const metadata = buildDatasetMetadata(
    datasetId,
    datasetName,
    tables,
    relationships,
  );

  /**
   * Validated here as well as inside the client. The client validates so a bad
   * response never escapes it; this validates so nothing invalid can reach the
   * Configs write regardless of which client implementation is in use. Storage
   * is the invariant that matters, so the check belongs next to it too.
   *
   * Returns Claude's raw (unresolved-metric) output. Resolution happens once,
   * outside this closure, after a validated attempt has actually succeeded --
   * see below.
   */
  const attempt = async (
    stricterInstruction?: string,
  ): Promise<DashboardConfigShape> => {
    const raw = await claude.generateConfig(
      metadata,
      tables,
      stricterInstruction ? { stricterInstruction } : undefined,
    );

    const parsed = dashboardConfigSchema.safeParse(raw);

    if (!parsed.success) {
      throw new ClaudeValidationError(
        `Config failed schema validation before storage: ${JSON.stringify(parsed.error.issues)}`,
      );
    }

    const problems = findUnknownReferences(parsed.data, tables);

    if (problems.length > 0) {
      throw new ClaudeValidationError(
        `Config references names absent from the dataset: ${problems.join("; ")}`,
      );
    }

    // Section 9.0, re-checked here immediately before storage same as
    // findUnknownReferences above: nothing invalid reaches the Configs
    // write regardless of which client implementation produced it.
    const extraTabWidgets = findExtraTabWidgets(
      parsed.data,
      metadata.rawSheetTableName,
    );

    if (extraTabWidgets.length > 0) {
      throw new ClaudeValidationError(
        `Config created a widget for a table other than the identified raw sheet "${metadata.rawSheetTableName}": ${extraTabWidgets.join("; ")}`,
      );
    }

    // Section 9.1, re-checked here for the same reason as the two checks
    // above: an insight metric that doesn't resolve against real data is a
    // validation failure, not something storage should ever see.
    const unresolvableMetrics = findUnresolvableMetrics(
      parsed.data.insights,
      tables,
    );

    if (unresolvableMetrics.length > 0) {
      throw new ClaudeValidationError(
        `Config has insight metrics that don't resolve against real data: ${unresolvableMetrics.join("; ")}`,
      );
    }

    return parsed.data;
  };

  let validated: DashboardConfigShape;

  try {
    validated = await attempt();
  } catch (firstError: unknown) {
    if (!isOutputQualityFailure(firstError)) {
      if (firstError instanceof ClaudeBillingError) {
        throw firstError;
      }

      throw new IngestionError(
        `Config generation first-call failure, no retry attempted: ${
          firstError instanceof Error ? firstError.message : String(firstError)
        }`,
      );
    }

    const violation =
      firstError instanceof Error ? firstError.message : String(firstError);

    logger.warn(
      `Config failed validation, retrying once on model "${claude.retryModelName}". Violation: ${violation}`,
    );

    const stricter = [
      `The exact violation was: ${violation}`,
      "Every sourceTable must be a table name from the metadata, verbatim.",
      "Every entry in fields must be a column name that exists in that table,",
      "verbatim. Emit no keys beyond those in the tool schema. Provide at least",
      "one tab. Call emit_dashboard_config exactly once.",
      metadata.rawSheetTableName
        ? `Every widget's sourceTable must be exactly "${metadata.rawSheetTableName}" -- do not create a widget for any other table, even one that seems relevant. Insights may still name other tables in relatedTables.`
        : "",
      "Every insight metric needs a kind. kind:\"aggregate\" needs",
      "sourceTable/sourceField (a real table/column name, verbatim) and an",
      "aggregation suiting that column's type (never sum/avg/min/max a",
      "non-numeric column). kind:\"row\" needs sourceTable/labelColumn/",
      "labelValue/valueColumn instead, no aggregation field -- use it for a",
      "table with preferRowAddressing:true or a row listed in",
      "namedFigureRows. Do not include a `value` field on any metric -- you",
      "never supply one.",
    ]
      .filter(Boolean)
      .join(" ");

    try {
      validated = await attempt(stricter);
    } catch (secondError: unknown) {
      if (secondError instanceof ClaudeBillingError) {
        throw secondError;
      }

      const detail =
        secondError instanceof Error
          ? secondError.message
          : String(secondError);

      throw new IngestionError(
        `Config generation failed validation twice, second attempt used ANTHROPIC_RETRY_MODEL "${claude.retryModelName || "unset, fell back to the primary model"}". First violation: ${violation} Second failure: ${detail}`,
      );
    }
  }

  // Section 9.1: resolution happens exactly once, after a validated attempt
  // has already confirmed every metric resolves cleanly -- so this never
  // needs to check for its own errors. resolvedDashboardConfigSchema is
  // re-validated anyway, matching the same "trust nothing, check again right
  // before storage" discipline as the raw config above.
  const resolvedConfig: ResolvedDashboardConfigShape = {
    ...validated,
    insights: resolveInsightMetrics(validated.insights, tables),
  };

  const revalidated = resolvedDashboardConfigSchema.safeParse(resolvedConfig);

  if (!revalidated.success) {
    throw new IngestionError(
      `Resolved config failed schema validation before storage: ${JSON.stringify(revalidated.error.issues)}`,
    );
  }

  return revalidated.data;
};

export const processIngestionJob = async (
  data: IngestionJobData,
  deps: IngestionDeps,
): Promise<void> => {
  const { payload, gemini, claude, datasetLock, queue, events } = deps;
  const mediaDir = deps.mediaDir ?? MEDIA_DIR;
  const limits = readIngestionLimits();

  await payload.update({
    collection: "jobs",
    id: data.jobId,
    data: { status: "processing" },
  });
  await events.publish("job.updated", data.datasetId, data.jobId);

  const jobRecord = await payload.findByID({
    collection: "jobs",
    id: data.jobId,
    depth: 0,
  });

  const fileRecord = await payload.findByID({
    collection: "files",
    id: data.fileId,
    depth: 0,
  });

  if (!fileRecord.filename || !fileRecord.mimeType) {
    throw new IngestionError(
      "File record is missing a filename or mime type. Re-upload the file.",
    );
  }

  // Refuses unsupported formats before reading or parsing anything.
  const fileType = resolveDeterministicType(fileRecord.mimeType);
  const bytes = await loadFileBytes(mediaDir, fileRecord.filename);

  await payload.update({
    collection: "jobs",
    id: data.jobId,
    data: { status: "validating" },
  });
  await events.publish("job.updated", data.datasetId, data.jobId);

  const parsed = parseSpreadsheet(
    bytes,
    fileRecord.mimeType,
    fileRecord.filename,
    limits,
  );

  await payload.update({
    collection: "jobs",
    id: data.jobId,
    data: { status: "generating_config" },
  });
  await events.publish("job.updated", data.datasetId, data.jobId);

  const datasetId =
    jobRecord.dataset === null || jobRecord.dataset === undefined
      ? data.datasetId
      : String(jobRecord.dataset);

  // Per-dataset lock (PRD 11.4), acquired the moment datasetId is known and
  // before any Gemini/Claude call, so contention is discovered before this
  // attempt has spent anything on a model request. jobId doubles as the
  // lock token: unique per job, and already the identifier this job is
  // known by everywhere else.
  const lockToken = data.jobId;
  const lockAcquired = await datasetLock.acquireLock(datasetId, lockToken);

  if (!lockAcquired) {
    // Contention, not failure: another job is already ingesting into this
    // dataset. Requeue this job with a delay instead of failing it, and log
    // it distinctly so it never reads as a real ingestion error.
    payload.logger.warn(
      `Dataset ${datasetId} is locked by another in-flight job; requeuing job ${data.jobId} in ${LOCK_RETRY_DELAY_MS}ms instead of failing it (lock contention, not an error).`,
    );

    await queue.add(
      "ingest",
      data,
      {
        // A fresh id per retry attempt: the original BullMQ job id
        // (job-${jobId}) is kept by removeOnComplete:false/removeOnFail:false
        // policy elsewhere, so reusing it here would collide instead of
        // scheduling a new attempt.
        jobId: `job-${data.jobId}-lock-retry-${Date.now()}`,
        delay: LOCK_RETRY_DELAY_MS,
        removeOnComplete: false,
        removeOnFail: false,
      },
    );

    // Back to "queued": ingestion has not actually progressed, so neither
    // "completed" nor "failed" would be accurate.
    await payload.update({
      collection: "jobs",
      id: data.jobId,
      data: { status: "queued" },
    });
    await events.publish("job.updated", datasetId, data.jobId);

    return;
  }

  try {
    const { dataset: normalized, totalDataRows } = await inferAndMerge(
      gemini,
      parsed,
      datasetId,
      {
        name: fileRecord.filename,
        type: fileType,
        hash: data.fileHash,
      },
      payload.logger,
    );

    // Only now, after full validation, is stored data replaced.
    await payload.update({
      collection: "datasets",
      id: datasetId,
      data: {
        data: {
          tables: normalized.tables,
          relationships: normalized.relationships,
        },
        tableNames: normalized.tables.map((table) => ({
          tableName: table.tableName,
        })),
        totalRows: totalDataRows,
        currentFile: fileRecord.id,
        currentFileHash: data.fileHash,
        status: "ready",
        // A successful parse clears any error recorded by a previous failed
        // job against this dataset, so the dashboard never shows a stale
        // failure banner once the data has actually recovered.
        lastError: null,
      },
    });
    await events.publish("dataset.updated", datasetId, data.jobId);

    // Config generation is part of this pipeline, not a separate trigger, so
    // the job stays open until a Config exists. A dataset that is ready with
    // no dashboard is exactly the half-finished state Section 7.6 forbids
    // presenting as complete.
    const datasetRecord = await payload.findByID({
      collection: "datasets",
      id: datasetId,
      depth: 0,
    });

    const config = await generateConfig(
      claude,
      datasetId,
      datasetRecord.name,
      normalized.tables,
      normalized.relationships,
      payload.logger,
    );

    // Version is never hardcoded: re-ingesting the same dataset (a corrected
    // re-upload after an earlier failure, or any future re-run) must not
    // create a second tied version, which the config-fetch route could then
    // return nondeterministically instead of the newest one.
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
        config,
        insights: config.insights,
        generatedBy: CONFIG_SOURCE.initialAutoGeneration,
      },
    });
    await events.publish("config.updated", datasetId, data.jobId);

    await payload.update({
      collection: "jobs",
      id: data.jobId,
      data: {
        status: "completed",
        completedAt: new Date().toISOString(),
        error: null,
      },
    });
    await events.publish("job.updated", datasetId, data.jobId);
  } finally {
    await datasetLock.releaseLock(datasetId, lockToken);
  }
};

export {
  EmptyFileError,
  LimitExceededError,
  MergeError,
  UnsupportedFileTypeError,
};
