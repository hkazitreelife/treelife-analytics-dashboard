"use client";

import type { DashboardConfigShape } from "@analytics/shared";
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
};

type Phase =
  | { kind: "loading" }
  | { kind: "error"; title: string; detail?: string | null }
  | { kind: "ready"; dataset: DatasetSummary; config: DashboardConfigShape; version: number };

const ROW_LIMIT = 100;

export const DashboardRenderer = ({ datasetId }: { datasetId: string }) => {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [tables, setTables] = useState<Record<string, TableState>>({});

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

        // A failed dataset must say so, with its stored error, not render blank.
        if (dataset.status === "failed") {
          const jobs = await fetch(
            `/api/datasets/${datasetId}/data`,
            { credentials: "include" },
          );
          const body = (await jobs.json()) as { error?: string };

          setPhase({
            kind: "error",
            title: `Dataset "${dataset.name}" failed to process`,
            detail:
              body.error ??
              "No stored data is available for this dataset. Check the job record for the technical error.",
          });

          return;
        }

        if (!configResponse.ok) {
          const body = (await configResponse.json()) as { error?: string };

          setPhase({
            kind: "error",
            title: "No dashboard configuration",
            detail:
              body.error ??
              `GET /api/datasets/${datasetId}/config returned ${configResponse.status}.`,
          });

          return;
        }

        const configBody = (await configResponse.json()) as ConfigResponse;

        setPhase({
          kind: "ready",
          dataset,
          config: configBody.config,
          version: configBody.version,
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

  useEffect(() => {
    if (requiredTables.length === 0) {
      return;
    }

    let cancelled = false;

    setTables((current) => {
      const next = { ...current };

      for (const name of requiredTables) {
        next[name] ??= { status: "loading" };
      }

      return next;
    });

    const loadTable = async (tableName: string): Promise<void> => {
      try {
        const response = await fetch(
          `/api/datasets/${datasetId}/data?table=${encodeURIComponent(tableName)}&limit=${ROW_LIMIT}`,
          { credentials: "include" },
        );

        if (cancelled) {
          return;
        }

        if (!response.ok) {
          const body = (await response.json()) as { error?: string };

          setTables((current) => ({
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

        setTables((current) => ({
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
          setTables((current) => ({
            ...current,
            [tableName]: {
              status: "error",
              message: error instanceof Error ? error.message : String(error),
            },
          }));
        }
      }
    };

    void Promise.all(requiredTables.map((name) => loadTable(name)));

    return () => {
      cancelled = true;
    };
  }, [datasetId, requiredTables]);

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

  const { config, dataset, version } = phase;
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
      <header>
        <h1 className="text-xl font-semibold text-[color:var(--color-forest)]">
          {config.title}
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-steel)]">
          {dataset.name} · {dataset.totalRows.toLocaleString("en-IN")} rows ·
          status {dataset.status} · config v{version}
        </p>
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
                  .map((widget) => (
                    <WidgetRenderer
                      key={widget.widgetId}
                      widget={widget}
                      state={
                        tables[widget.sourceTable] ?? { status: "loading" }
                      }
                    />
                  ))}
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
    </div>
  );
};
