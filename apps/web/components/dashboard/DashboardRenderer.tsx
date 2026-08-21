"use client";

import {
  DEFAULT_LIMITS,
  type DashboardWidgetShape,
  type ResolvedDashboardConfigShape,
} from "@analytics/shared";
import { useEffect, useMemo, useState } from "react";

import { DashboardExportBar } from "@/components/dashboard/ExportActions";
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
import { TreelifeLogo } from "@/components/ui/BrandLogo";

/**
 * The renderer. It draws whatever the config describes and nothing else: no
 * dataset-specific components, no assumed tab or widget count, no hardcoded
 * table or column names. A new dataset needs no code change here.
 *
 * Impeccable critique 2026-08-13, P1 "duplicate, unsynchronized chat/edit
 * surfaces": this used to also carry its own embedded prompt-edit and chat
 * forms, doing the identical two actions ContextChatEditPanel.tsx's right
 * rail already does against the identical endpoints, with no shared
 * history between them. Per the critique's resolution (right rail
 * canonical), both are removed here. Config edits made via the right rail
 * still land here exactly as before, through the SSE config.updated
 * listener below -- that path never depended on which form wrote the edit.
 */

type ConfigResponse = {
  version: number;
  generatedBy: string;
  config: ResolvedDashboardConfigShape;
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
      config: ResolvedDashboardConfigShape;
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
  "horizontal_bar",
  "line",
  "pie",
]);

/** Whether a widget's displayed number depends on seeing every row, not just a preview. */
const needsFullTableAggregation = (widget: DashboardWidgetShape): boolean =>
  CHART_WIDGET_TYPES.has(widget.type) && widget.aggregation !== "none";

const isOverviewTab = (tab: { tabId: string; tabName: string }): boolean =>
  tab.tabId === "executive_overview" || /overview/i.test(tab.tabName ?? "");

/**
 * Scopes a config's insights to one tab, by intersecting each insight's
 * relatedTables with the set of sourceTable(s) that tab's own widgets
 * actually use. Without this, every tab showed the exact same full
 * insights list regardless of which sheet's tab was open -- there was no
 * per-tab filtering at all, insights were rendered once, globally, below
 * every tab. An insight with an empty relatedTables (a genuinely
 * cross-sheet finding, not tied to one table) is treated as
 * overview-level and shown only on the tab identified as the cross-sheet
 * overview, per the same "ONE TAB PER SHEET, plus one overview" rule the
 * config-generation prompt now enforces (apps/web/lib/directIngestion.ts).
 */
const insightsForTab = (
  insights: ResolvedDashboardConfigShape["insights"] | undefined,
  tab: { tabId: string; tabName: string; widgets: DashboardWidgetShape[] },
): ResolvedDashboardConfigShape["insights"] => {
  if (!Array.isArray(insights) || insights.length === 0) {
    return [];
  }

  const tabTables = new Set(tab.widgets.map((widget) => widget.sourceTable));

  return insights.filter((insight) => {
    const related = (insight as any).relatedTables as string[] | undefined;

    if (!Array.isArray(related) || related.length === 0) {
      return isOverviewTab(tab);
    }

    return related.some((tableName) => tabTables.has(tableName));
  });
};

type SetTableState = (
  updater: (current: Record<string, TableState>) => Record<string, TableState>,
) => void;

import { fetchJsonCached, invalidateClientCache } from "@/lib/clientCache";

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
      const url = `/api/datasets/${datasetId}/data?table=${encodeURIComponent(tableName)}&limit=${limit}`;
      const body = await fetchJsonCached<{
        columns: { name: string; inferredType: string }[];
        rows: Record<string, unknown>[];
        totalRows: number;
      }>(url, 120_000);

      if (cancelled) {
        return;
      }

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

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      setPhase({ kind: "loading" });

      try {
        const [dataset, configBody] = await Promise.all([
          fetchJsonCached<DatasetSummary>(`/api/datasets/${datasetId}`, 60_000),
          fetchJsonCached<ConfigResponse>(`/api/datasets/${datasetId}/config`, 60_000),
        ]);

        if (cancelled) {
          return;
        }

        const latestVersion = configBody.version;
        const config = configBody.config;

        const failureBanner =
          dataset.status === "failed"
            ? (dataset.lastError ?? "The latest dataset processing failed.")
            : null;

        setPhase({
          kind: "ready",
          dataset,
          config,
          version: latestVersion,
          failureBanner,
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

    for (const tab of phase.config?.tabs ?? []) {
      for (const widget of tab?.widgets ?? []) {
        if (widget?.sourceTable) {
          names.add(widget.sourceTable);
        }
      }
    }

    for (const insight of phase.config?.insights ?? []) {
      for (const table of (insight as any)?.relatedTables ?? []) {
        names.add(table);
      }
      for (const metric of (insight as any)?.metrics ?? []) {
        if (metric?.sourceTable) {
          names.add(metric.sourceTable);
        }
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

    for (const tab of phase.config?.tabs ?? []) {
      for (const widget of tab?.widgets ?? []) {
        if (widget && needsFullTableAggregation(widget)) {
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

      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-3 border-b border-[color:var(--color-cloud)]/70">
        <div className="flex items-center gap-3.5">
          <TreelifeLogo size="md" className="h-12 sm:h-16 w-auto max-w-[260px] shrink-0" />
          <div>
            <h1 className="text-xl font-bold text-[color:var(--color-forest)]">
              {config.title}
            </h1>
            <p className="mt-0.5 text-xs text-[color:var(--color-steel)]">
              {dataset.name} · {dataset.totalRows.toLocaleString("en-IN")} rows ·
              status {dataset.status} · config v{version}
            </p>
          </div>
        </div>

        <DashboardExportBar
          title={config.title}
          datasetName={dataset.name}
          tables={tables as any}
        />
      </header>

      <Tabs defaultValue={firstTab.tabId}>
        <TabsList>
          {config.tabs.map((tab) => (
            <TabsTrigger key={tab.tabId} value={tab.tabId}>
              {tab.tabName}
            </TabsTrigger>
          ))}
        </TabsList>

        {config.tabs.map((tab) => (
          <TabsContent key={tab.tabId} value={tab.tabId} forceMount className="mt-4 data-[state=inactive]:hidden">
            {(tab.widgets?.length ?? 0) === 0 ? (
              <ErrorState
                title={`Tab "${tab.tabName}" has no widgets`}
                detail="The configuration defines this tab but places nothing in it."
              />
            ) : (
              <div
                className="grid grid-cols-1 gap-4 md:grid-cols-12"
                style={{ gridAutoRows: "minmax(5.25rem, auto)" }}
              >
                {[...(tab.widgets ?? [])]
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

            {/* Insights scoped to this tab's own table(s) -- this used to
                be one global section below the tabs, rendering every
                insight from every sheet identically regardless of which
                tab was open. insightsForTab filters to insights whose
                relatedTables intersects this tab's own widgets'
                sourceTable(s); an insight with no relatedTables at all is
                treated as overview-level and shown only on the tab
                identified as the cross-sheet overview. */}
            {(() => {
              const tabInsights = insightsForTab(config.insights ?? [], tab);

              return tabInsights.length > 0 ? (
                <section className="mt-6 space-y-3">
                  <h2 className="text-base font-semibold text-[color:var(--color-forest)]">
                    Insights
                  </h2>
                  <InsightsPanel insights={tabInsights} tables={tables} />
                </section>
              ) : null;
            })()}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
};

export const CombinedDashboardRenderer = ({
  config,
  datasetId,
}: {
  config: ResolvedDashboardConfigShape;
  datasetId?: string;
}) => {
  const [tables, setTables] = useState<Record<string, TableState>>({});
  const [aggregateData, setAggregateData] = useState<Record<string, TableState>>({});

  const previewTableNames = useMemo(() => {
    const names = new Set<string>();

    for (const tab of config.tabs) {
      for (const widget of tab.widgets) {
        if (!needsFullTableAggregation(widget)) {
          names.add(widget.sourceTable);
        }
      }
    }

    for (const insight of config.insights ?? []) {
      for (const table of (insight as any).relatedTables ?? []) {
        names.add(table);
      }
      for (const metric of (insight as any).metrics ?? []) {
        if (metric.sourceTable) {
          names.add(metric.sourceTable);
        }
      }
    }

    return Array.from(names);
  }, [config]);

  const aggregateTableNames = useMemo(
    () =>
      Array.from(
        new Set(
          config.tabs
            .flatMap((tab) => tab.widgets)
            .filter((widget) => needsFullTableAggregation(widget))
            .map((widget) => widget.sourceTable),
        ),
      ),
    [config],
  );

  useEffect(() => {
    if (!datasetId) return;
    return loadTablesInto(datasetId, previewTableNames, ROW_LIMIT, setTables);
  }, [datasetId, previewTableNames]);

  useEffect(() => {
    if (!datasetId) return;
    return loadTablesInto(datasetId, aggregateTableNames, AGGREGATE_ROW_LIMIT, setAggregateData);
  }, [datasetId, aggregateTableNames]);

  const firstTab = config.tabs[0];

  return (
    <div className="space-y-6">
      {firstTab && firstTab.widgets.length > 0 ? (
        <Tabs defaultValue={firstTab.tabId}>
          {config.tabs.length > 1 ? (
            <TabsList>
              {config.tabs.map((tab) => (
                <TabsTrigger key={tab.tabId} value={tab.tabId}>
                  {tab.tabName}
                </TabsTrigger>
              ))}
            </TabsList>
          ) : null}

          {config.tabs.map((tab) => (
            <TabsContent key={tab.tabId} value={tab.tabId} forceMount className="mt-4 data-[state=inactive]:hidden">
              {tab.widgets.length === 0 ? null : (
                <div
                  className="grid grid-cols-1 gap-4 md:grid-cols-12"
                  style={{ gridAutoRows: "minmax(5.25rem, auto)" }}
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

              {/* Scoped to this tab's own table(s), same fix and same
                  reasoning as DashboardRenderer above -- this was one
                  global insights section below every tab before, showing
                  every insight identically regardless of which tab was
                  open. */}
              {(() => {
                const tabInsights = insightsForTab(config.insights, tab);

                return tabInsights.length > 0 ? (
                  <section className="mt-6 space-y-3">
                    <h2 className="text-base font-semibold text-[color:var(--color-forest)]">
                      Executive Insights & Strategy
                    </h2>
                    <InsightsPanel insights={tabInsights} tables={tables} />
                  </section>
                ) : null;
              })()}
            </TabsContent>
          ))}
        </Tabs>
      ) : null}
    </div>
  );
};

