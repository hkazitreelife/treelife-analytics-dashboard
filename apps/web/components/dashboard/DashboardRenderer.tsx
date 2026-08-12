"use client";

import { DEFAULT_LIMITS, type DashboardConfigShape, type DashboardWidgetShape } from "@analytics/shared";
import { useEffect, useMemo, useState } from "react";

import { InsightsPanel } from "@/components/dashboard/InsightsPanel";
import {
  WidgetRenderer,
  type TableState,
} from "@/components/dashboard/WidgetRenderer";
import {
  ErrorState,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/primitives";

/**
 * The renderer. It draws whatever the config describes and nothing else: no
 * dataset-specific components, no assumed tab or widget count, no hardcoded
 * table or column names. A new dataset needs no code change here.
 */

type ConfigResponse = {
  version: number;
  generatedBy: string;
  config: DashboardConfigShape;
};

type DatasetSummary = {
  id: string;
  name: string;
  status: string;
  totalRows: number;
  lastError: string | null;
};

type Phase =
  | { kind: "loading" }
  | { kind: "error"; title: string; detail?: string | null }
  | {
      kind: "ready";
      dataset: DatasetSummary;
      config: DashboardConfigShape;
      version: number;
      // Set when status is "failed" but a previous successful ingestion left
      // good data and config in place (PRD 11.3): the dashboard renders as
      // normal, with this banner on top, rather than going blank.
      failureBanner: string | null;
    };

const ROW_LIMIT = 100;

// Chart aggregation (sum/avg/count) must reflect the whole table, not the
// 100-row preview used for the table widget and for computing what to
// display. The cap here matches the ingestion-time per-table row limit: a
// table can never have stored more rows than this, so requesting up to it is
// requesting "all of it", not an arbitrary larger preview.
const AGGREGATE_ROW_LIMIT = DEFAULT_LIMITS.maxRowsPerTable;

const CHART_WIDGET_TYPES = new Set<DashboardWidgetShape["type"]>([
  "bar",
  "line",
  "pie",
]);

/** Whether a widget's displayed number depends on seeing every row, not just a preview. */
const needsFullTableAggregation = (widget: DashboardWidgetShape): boolean =>
  CHART_WIDGET_TYPES.has(widget.type) && widget.aggregation !== "none";

type SetTableState = (
  updater: (current: Record<string, TableState>) => Record<string, TableState>,
) => void;

/**
 * Fetches each named table's rows into a state map, up to `limit` rows.
 * Shared by the 100-row preview fetch (table/kpi widgets, and charts with no
 * aggregation) and the full-table fetch (aggregating charts only). Returns
 * the cleanup function a useEffect should return.
 */
const loadTablesInto = (
  datasetId: string,
  tableNames: string[],
  limit: number,
  setState: SetTableState,
): (() => void) => {
  let cancelled = false;

  if (tableNames.length === 0) {
    return () => {
      cancelled = true;
    };
  }

  setState((current) => {
    const next = { ...current };

    for (const name of tableNames) {
      next[name] ??= { status: "loading" };
    }

    return next;
  });

  const loadTable = async (tableName: string): Promise<void> => {
    try {
      const response = await fetch(
        `/api/datasets/${datasetId}/data?table=${encodeURIComponent(tableName)}&limit=${limit}`,
        { credentials: "include" },
      );

      if (cancelled) {
        return;
      }

      if (!response.ok) {
        const body = (await response.json()) as { error?: string };

        setState((current) => ({
          ...current,
          [tableName]: {
            status: "error",
            message: body.error ?? `Request returned ${response.status}.`,
          },
        }));

        return;
      }

      const body = (await response.json()) as {
        columns: { name: string; inferredType: string }[];
        rows: Record<string, unknown>[];
        totalRows: number;
      };

      setState((current) => ({
        ...current,
        [tableName]: {
          status: "ready",
          columns: body.columns,
          rows: body.rows,
          totalRows: body.totalRows,
        },
      }));
    } catch (error: unknown) {
      if (!cancelled) {
        setState((current) => ({
          ...current,
          [tableName]: {
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          },
        }));
      }
    }
  };

  void Promise.all(tableNames.map((name) => loadTable(name)));

  return () => {
    cancelled = true;
  };
};

export const DashboardRenderer = ({ datasetId }: { datasetId: string }) => {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [tables, setTables] = useState<Record<string, TableState>>({});
  // Separate from `tables`: only populated for tables that back a chart
  // widget with a non-none aggregation, fetched up to AGGREGATE_ROW_LIMIT
  // instead of ROW_LIMIT, so that aggregation math is correct rather than
  // computed over the first 100 rows.
  const [aggregateData, setAggregateData] = useState<Record<string, TableState>>({});
  // Bumped by the SSE listener's dataset.updated handler to re-trigger the two
  // table-fetch effects below without touching config or reloading the page.
  const [dataRefreshToken, setDataRefreshToken] = useState(0);

  // Section 13: prompt-based editing. A minimal control surface for the
  // existing POST /api/datasets/:id/config/prompt endpoint -- the SSE
  // listener below already refetches config on success, so this only needs
  // to submit the request and show a pending/result state.
  const [promptValue, setPromptValue] = useState("");
  const [promptStatus, setPromptStatus] = useState<
    | { kind: "idle" }
    | { kind: "pending" }
    | { kind: "success"; version: number }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  // Section 17: read-only chat. Same minimal shape as the prompt-edit
  // control above -- an input, a submit, a pending/result state -- with no
  // SSE involvement, since a chat answer changes nothing that needs
  // re-rendering elsewhere.
  const [chatMessage, setChatMessage] = useState("");
  const [chatStatus, setChatStatus] = useState<
    | { kind: "idle" }
    | { kind: "pending" }
    | { kind: "answered"; answer: string; sources: string[] }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      setPhase({ kind: "loading" });

      try {
        const [datasetResponse, configResponse] = await Promise.all([
          fetch(`/api/datasets/${datasetId}`, { credentials: "include" }),
          fetch(`/api/datasets/${datasetId}/config`, { credentials: "include" }),
        ]);

        if (cancelled) {
          return;
        }

        if (datasetResponse.status === 401 || configResponse.status === 401) {
          setPhase({
            kind: "error",
            title: "Not signed in",
            detail: "Sign in at /admin, then reload this page.",
          });

          return;
        }

        if (!datasetResponse.ok) {
          setPhase({
            kind: "error",
            title: "Dataset not found",
            detail: `GET /api/datasets/${datasetId} returned ${datasetResponse.status}.`,
          });

          return;
        }

        const dataset = (await datasetResponse.json()) as DatasetSummary;

        // No config has ever been generated for this dataset (the pipeline
        // creates a Config only after a Dataset's data write succeeds, so
        // this means no ingestion has ever completed successfully). There is
        // nothing to render.
        if (!configResponse.ok) {
          const body = (await configResponse.json()) as { error?: string };

          setPhase({
            kind: "error",
            title:
              dataset.status === "failed"
                ? `Dataset "${dataset.name}" failed to process`
                : "No dashboard configuration",
            detail:
              dataset.status === "failed"
                ? (dataset.lastError ??
                  "No stored data or dashboard configuration is available for this dataset.")
                : (body.error ??
                  `GET /api/datasets/${datasetId}/config returned ${configResponse.status}.`),
          });

          return;
        }

        const configBody = (await configResponse.json()) as ConfigResponse;

        // status "failed" with a config already in hand means a later job
        // (a bad re-upload, or a config-generation failure after a good
        // re-parse) failed, but a working dashboard from an earlier success
        // is still on record. Render it, with the real error as a banner,
        // rather than presenting a blank "no data" screen (PRD 11.3).
        setPhase({
          kind: "ready",
          dataset,
          config: configBody.config,
          version: configBody.version,
          failureBanner:
            dataset.status === "failed"
              ? (dataset.lastError ??
                "The most recent update to this dataset failed. Showing the last successful version.")
              : null,
        });
      } catch (error: unknown) {
        if (!cancelled) {
          setPhase({
            kind: "error",
            title: "Could not load this dashboard",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [datasetId]);

  // Every distinct sourceTable the config asks for, fetched once each.
  const requiredTables = useMemo(() => {
    if (phase.kind !== "ready") {
      return [] as string[];
    }

    const names = new Set<string>();

    for (const tab of phase.config.tabs) {
      for (const widget of tab.widgets) {
        names.add(widget.sourceTable);
      }
    }

    return Array.from(names);
  }, [phase]);

  // The subset of requiredTables that back a chart widget with a non-none
  // aggregation, and therefore need every row, not the 100-row preview.
  const aggregateTables = useMemo(() => {
    if (phase.kind !== "ready") {
      return [] as string[];
    }

    const names = new Set<string>();

    for (const tab of phase.config.tabs) {
      for (const widget of tab.widgets) {
        if (needsFullTableAggregation(widget)) {
          names.add(widget.sourceTable);
        }
      }
    }

    return Array.from(names);
  }, [phase]);

  // Preview fetch: 100 rows, used by table/kpi widgets and by charts with no
  // aggregation. Re-runs on dataRefreshToken so a dataset.updated SSE event
  // refetches the same tables without a full page reload.
  useEffect(
    () => loadTablesInto(datasetId, requiredTables, ROW_LIMIT, setTables),
    [datasetId, requiredTables, dataRefreshToken],
  );

  // Full-table fetch: only for tables backing an aggregating chart, so the
  // sum/avg/count shown reflects the whole table rather than the preview.
  useEffect(
    () => loadTablesInto(datasetId, aggregateTables, AGGREGATE_ROW_LIMIT, setAggregateData),
    [datasetId, aggregateTables, dataRefreshToken],
  );

  // Section 18.3: on dataset.updated, refetch the affected data; on
  // config.updated, refetch config and re-render; on job.updated, no-op for
  // now (no job-status UI exists yet) but still handled explicitly so an
  // event type this component doesn't otherwise act on never surfaces as
  // unhandled. One EventSource per successfully-loaded dashboard.
  useEffect(() => {
    if (phase.kind !== "ready") {
      return;
    }

    const source = new EventSource(`/api/events/datasets/${datasetId}`);

    const onDatasetUpdated = (): void => {
      setDataRefreshToken((token) => token + 1);
    };

    const onConfigUpdated = (): void => {
      void (async () => {
        try {
          const response = await fetch(
            `/api/datasets/${datasetId}/config`,
            { credentials: "include" },
          );

          if (!response.ok) {
            return;
          }

          const body = (await response.json()) as ConfigResponse;

          setPhase((current) =>
            current.kind === "ready"
              ? { ...current, config: body.config, version: body.version }
              : current,
          );
        } catch {
          // A missed live update is not fatal: the next SSE event, or a
          // manual reload, catches the dashboard up. Never let this throw.
        }
      })();
    };

    const onJobUpdated = (): void => {
      // Deliberately empty: no job-status UI exists yet to update.
    };

    source.addEventListener("dataset.updated", onDatasetUpdated);
    source.addEventListener("config.updated", onConfigUpdated);
    source.addEventListener("job.updated", onJobUpdated);

    source.onerror = () => {
      // EventSource retries on its own; a transient network error here must
      // never surface as an app-level error state.
    };

    return () => {
      source.close();
    };
  }, [datasetId, phase.kind]);

  const handlePromptSubmit = async (
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    const trimmed = promptValue.trim();

    if (!trimmed || promptStatus.kind === "pending") {
      return;
    }

    setPromptStatus({ kind: "pending" });

    try {
      const response = await fetch(
        `/api/datasets/${datasetId}/config/prompt`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: trimmed }),
        },
      );

      const body = (await response.json()) as {
        configVersion?: number;
        error?: string;
      };

      if (!response.ok) {
        setPromptStatus({
          kind: "error",
          message: body.error ?? `Request returned ${response.status}.`,
        });

        return;
      }

      // Deliberately no manual config refetch here: config.updated over SSE
      // already does it (Section 18.3). This just confirms success.
      setPromptStatus({ kind: "success", version: body.configVersion ?? 0 });
      setPromptValue("");
    } catch (error: unknown) {
      setPromptStatus({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleChatSubmit = async (
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();

    const trimmed = chatMessage.trim();

    if (!trimmed || chatStatus.kind === "pending") {
      return;
    }

    setChatStatus({ kind: "pending" });

    try {
      const response = await fetch(`/api/datasets/${datasetId}/chat`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
      });

      const body = (await response.json()) as {
        answer?: string;
        sources?: string[];
        error?: string;
      };

      if (!response.ok) {
        setChatStatus({
          kind: "error",
          message: body.error ?? `Request returned ${response.status}.`,
        });

        return;
      }

      setChatStatus({
        kind: "answered",
        answer: body.answer ?? "",
        sources: body.sources ?? [],
      });
    } catch (error: unknown) {
      setChatStatus({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  if (phase.kind === "loading") {
    return (
      <div className="space-y-4" aria-busy="true" aria-live="polite">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-10 w-96" />
        <div className="grid grid-cols-12 gap-4">
          <Skeleton className="col-span-3 h-28" />
          <Skeleton className="col-span-3 h-28" />
          <Skeleton className="col-span-3 h-28" />
          <Skeleton className="col-span-3 h-28" />
          <Skeleton className="col-span-6 h-64" />
          <Skeleton className="col-span-6 h-64" />
        </div>
      </div>
    );
  }

  if (phase.kind === "error") {
    return <ErrorState title={phase.title} detail={phase.detail} />;
  }

  const { config, dataset, version, failureBanner } = phase;
  const firstTab = config.tabs[0];

  if (!firstTab) {
    return (
      <ErrorState
        title="Configuration contains no tabs"
        detail="Nothing can be rendered from an empty tabs array."
      />
    );
  }

  return (
    <div className="space-y-6">
      {failureBanner ? (
        <ErrorState
          title={`The most recent update to "${dataset.name}" failed. Showing the last successful version.`}
          detail={failureBanner}
        />
      ) : null}

      <header>
        <h1 className="text-xl font-semibold text-[color:var(--color-forest)]">
          {config.title}
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-steel)]">
          {dataset.name} · {dataset.totalRows.toLocaleString("en-IN")} rows ·
          status {dataset.status} · config v{version}
        </p>
      </header>

      <form
        onSubmit={handlePromptSubmit}
        className="flex flex-wrap items-center gap-2 rounded-lg border border-[color:var(--color-cloud)] bg-white p-3"
      >
        <label htmlFor="dashboard-prompt" className="sr-only">
          Reshape this dashboard
        </label>
        <input
          id="dashboard-prompt"
          type="text"
          value={promptValue}
          onChange={(event) => setPromptValue(event.target.value)}
          placeholder='Reshape this dashboard, e.g. "Change the revenue chart to a pie chart."'
          disabled={promptStatus.kind === "pending"}
          className="min-w-64 flex-1 rounded-md border border-[color:var(--color-cloud)] px-3 py-1.5 text-sm text-[color:var(--color-ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-cobalt)] disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={
            promptStatus.kind === "pending" || promptValue.trim().length === 0
          }
          className="rounded-md bg-[color:var(--color-forest)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {promptStatus.kind === "pending" ? "Applying…" : "Apply"}
        </button>
        {promptStatus.kind === "success" ? (
          <span
            role="status"
            className="text-xs text-[color:var(--color-risk-low)]"
          >
            Applied as config v{promptStatus.version}.
          </span>
        ) : null}
        {promptStatus.kind === "error" ? (
          <span role="alert" className="text-xs text-[color:var(--color-risk-high)]">
            {promptStatus.message}
          </span>
        ) : null}
      </form>

      <Tabs defaultValue={firstTab.tabId}>
        <TabsList>
          {config.tabs.map((tab) => (
            <TabsTrigger key={tab.tabId} value={tab.tabId}>
              {tab.tabName}
            </TabsTrigger>
          ))}
        </TabsList>

        {config.tabs.map((tab) => (
          <TabsContent key={tab.tabId} value={tab.tabId} className="mt-4">
            {tab.widgets.length === 0 ? (
              <ErrorState
                title={`Tab "${tab.tabName}" has no widgets`}
                detail="The configuration defines this tab but places nothing in it."
              />
            ) : (
              <div
                className="grid grid-cols-1 gap-4 md:grid-cols-12"
                style={{ gridAutoRows: "minmax(7rem, auto)" }}
              >
                {[...tab.widgets]
                  .sort(
                    (a, b) =>
                      a.position.row - b.position.row ||
                      a.position.col - b.position.col,
                  )
                  .map((widget) => {
                    const source = needsFullTableAggregation(widget)
                      ? aggregateData
                      : tables;

                    return (
                      <WidgetRenderer
                        key={widget.widgetId}
                        widget={widget}
                        state={
                          source[widget.sourceTable] ?? { status: "loading" }
                        }
                      />
                    );
                  })}
              </div>
            )}
          </TabsContent>
        ))}
      </Tabs>

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-[color:var(--color-forest)]">
          Insights
        </h2>
        <InsightsPanel insights={config.insights} />
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-[color:var(--color-forest)]">
          Ask about this data
        </h2>
        <form
          onSubmit={handleChatSubmit}
          className="flex flex-wrap items-center gap-2 rounded-lg border border-[color:var(--color-cloud)] bg-white p-3"
        >
          <label htmlFor="dashboard-chat" className="sr-only">
            Ask a question about this dataset
          </label>
          <input
            id="dashboard-chat"
            type="text"
            value={chatMessage}
            onChange={(event) => setChatMessage(event.target.value)}
            placeholder='e.g. "What is the gap to commit?"'
            disabled={chatStatus.kind === "pending"}
            className="min-w-64 flex-1 rounded-md border border-[color:var(--color-cloud)] px-3 py-1.5 text-sm text-[color:var(--color-ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-cobalt)] disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={
              chatStatus.kind === "pending" || chatMessage.trim().length === 0
            }
            className="rounded-md bg-[color:var(--color-forest)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {chatStatus.kind === "pending" ? "Asking…" : "Ask"}
          </button>
        </form>
        {chatStatus.kind === "answered" ? (
          <div
            role="status"
            className="rounded-lg border border-[color:var(--color-cloud)] bg-white p-3 text-sm text-[color:var(--color-ink)]"
          >
            <p>{chatStatus.answer}</p>
            {chatStatus.sources.length > 0 ? (
              <p className="mt-2 text-xs text-[color:var(--color-steel)]">
                Source: {chatStatus.sources.join(", ")}
              </p>
            ) : null}
          </div>
        ) : null}
        {chatStatus.kind === "error" ? (
          <p role="alert" className="text-xs text-[color:var(--color-risk-high)]">
            {chatStatus.message}
          </p>
        ) : null}
      </section>
    </div>
  );
};
