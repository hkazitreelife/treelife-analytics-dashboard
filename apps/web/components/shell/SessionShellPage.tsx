"use client";

import { useEffect, useState } from "react";

import { AppShell } from "@/components/shell/AppShell";
import { ContextChatEditPanel } from "@/components/shell/ContextChatEditPanel";
import type { ActiveSource, SingleSourceInfo } from "@/components/shell/types";
import { DashboardRenderer, CombinedDashboardRenderer } from "@/components/dashboard/DashboardRenderer";
import { DocumentSummaryRenderer } from "@/components/documents/DocumentSummaryRenderer";
import { InsightsPanel } from "@/components/dashboard/InsightsPanel";
import type { ResolvedDashboardConfigShape } from "@analytics/shared";
import { formatNumber } from "@/lib/aggregate";
import {
  Card,
  CardBody,
  EmptyState,
  ErrorState,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/primitives";

import { CrossSourceConnectionsView } from "@/components/dashboard/CrossSourceConnectionsView";
import { DashboardExportBar } from "@/components/dashboard/ExportActions";

import { fetchJsonCached } from "@/lib/clientCache";

/**
 * Prompt 12.0/15.0. The one session page every source lands on.
 */
type SourceRef = { id: string; name: string | null };

type Finding = {
  finding: string;
  whyItMatters: string;
  datasetId: string;
  datasetName: string;
  metric: { label: string; value: number; kind: "aggregate" | "row"; sourceTable: string };
  documentId: string;
  documentName: string;
  citation: { sectionId: string; quote: string };
};

type SessionInfo = {
  id: string;
  name: string;
  status: string;
  lastError: string | null;
  datasets: SourceRef[];
  documents: SourceRef[];
  singleSource: SingleSourceInfo;
  overview: {
    findings?: Finding[];
    config?: ResolvedDashboardConfigShape;
  };
};

type Phase =
  | { kind: "loading" }
  | { kind: "error"; title: string; detail?: string | null }
  | { kind: "ready"; session: SessionInfo };

export const SessionShellPage = ({ sessionId }: { sessionId: string }) => {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const session = await fetchJsonCached<SessionInfo>(
          `/api/sessions/${sessionId}`,
          refreshToken > 0 ? 0 : 60_000,
        );

        if (cancelled) {
          return;
        }

        setPhase({ kind: "ready", session });
      } catch (error: unknown) {
        if (!cancelled) {
          setPhase({
            kind: "error",
            title: "Could not load this session",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshToken]);

  const activeSource: ActiveSource | null =
    phase.kind === "ready"
      ? { sessionId, name: phase.session.name, singleSource: phase.session.singleSource }
      : null;

  return (
    <AppShell
      active={{ sessionId }}
      rightPanel={
        activeSource ? (
          <ContextChatEditPanel
            source={activeSource}
            onEditApplied={() => setRefreshToken((token) => token + 1)}
          />
        ) : null
      }
    >
      {phase.kind === "loading" ? (
        <div className="space-y-4" aria-busy="true" aria-live="polite">
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : phase.kind === "error" ? (
        <ErrorState title={phase.title} detail={phase.detail} />
      ) : (
        <SessionReady session={phase.session} refreshToken={refreshToken} />
      )}
    </AppShell>
  );
};

const SessionReady = ({ session, refreshToken }: { session: SessionInfo; refreshToken: number }) => {
  const datasets = session?.datasets ?? [];
  const documents = session?.documents ?? [];
  const totalSources = datasets.length + documents.length;

  if (totalSources === 1) {
    if (datasets.length === 1 && datasets[0]?.id) {
      return <DashboardRenderer datasetId={datasets[0].id} />;
    }

    if (documents.length === 1 && documents[0]?.id) {
      return (
        <DocumentSummaryRenderer documentId={documents[0].id} refreshToken={refreshToken} />
      );
    }
  }

  const findings = session?.overview?.findings ?? [];
  const [overviewTables, setOverviewTables] = useState<Record<string, any>>({});

  useEffect(() => {
    if (datasets.length === 0 || !datasets[0]?.id) return;
    const datasetId = datasets[0].id;

    const tableNames = new Set<string>();
    for (const f of findings) {
      if (f.metric?.sourceTable) tableNames.add(f.metric.sourceTable);
      for (const m of (f as any).metrics ?? []) {
        if (m?.sourceTable) tableNames.add(m.sourceTable);
      }
    }
    for (const tab of session?.overview?.config?.tabs ?? []) {
      for (const widget of tab?.widgets ?? []) {
        if (widget?.sourceTable) tableNames.add(widget.sourceTable);
      }
    }
    for (const insight of session?.overview?.config?.insights ?? []) {
      for (const table of (insight as any)?.relatedTables ?? []) {
        tableNames.add(table);
      }
      for (const metric of (insight as any)?.metrics ?? []) {
        if (metric?.sourceTable) tableNames.add(metric.sourceTable);
      }
    }

    if (tableNames.size === 0) {
      tableNames.add("Raw Data");
    }

    const loadTables = async () => {
      for (const tableName of tableNames) {
        try {
          const url = `/api/datasets/${datasetId}/data?table=${encodeURIComponent(tableName)}&limit=10000`;
          const data = await fetchJsonCached<any>(url, 120_000);
          setOverviewTables((prev) => ({
            ...prev,
            [tableName]: {
              status: "ready",
              rows: data.rows,
              columns: data.columns,
              totalRows: data.totalRows,
            },
          }));
        } catch {
          // ignore
        }
      }
    };

    void loadTables();
  }, [session.datasets, findings, session.overview.config]);

  return (
    <div className="space-y-6">
      {/* Session Title Bar */}
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[color:var(--color-cloud)]/80 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-extrabold tracking-tight text-[color:var(--color-forest)]">
              {session.name}
            </h1>
            <span className="rounded-full bg-[color:var(--color-forest-surface)] px-2.5 py-0.5 text-xs font-bold text-[color:var(--color-forest)] border border-[color:var(--color-forest-bright)]/20">
              Multi-Source Synthesis
            </span>
          </div>
          <p className="mt-1 text-xs text-[color:var(--color-steel)]">
            Synthesized across {session.datasets.length} dataset{session.datasets.length === 1 ? "" : "s"} and {session.documents.length} document{session.documents.length === 1 ? "" : "s"}
          </p>
        </div>

        <DashboardExportBar
          title={session.name}
          datasetName="Combined Workspace"
          tables={overviewTables}
        />
      </header>

      {session.status === "failed" ? (
        <ErrorState
          title="Synthesis failed"
          detail={session.lastError ?? "No technical detail was stored for this failure."}
        />
      ) : null}

      <Tabs defaultValue="overview">
        {/* Segmented Pill Navigation with Active Indicators & Count Badges */}
        <div className="flex items-center justify-between overflow-x-auto pb-1">
          <TabsList className="p-1 bg-[color:var(--color-cloud-light)] border border-[color:var(--color-cloud)] rounded-xl shadow-xs">
            <TabsTrigger value="overview" className="gap-1.5 px-4 py-2">
              <span>✦ Overview</span>
            </TabsTrigger>
            {session.datasets.map((dataset) => (
              <TabsTrigger key={dataset.id} value={`dataset-${dataset.id}`} className="gap-1.5 px-4 py-2">
                <span>📊 {dataset.name ?? dataset.id}</span>
                <span className="rounded-full bg-[color:var(--color-cloud)]/80 px-1.5 py-0.2 text-[10px] font-semibold">
                  Dataset
                </span>
              </TabsTrigger>
            ))}
            {session.documents.map((document) => (
              <TabsTrigger key={document.id} value={`document-${document.id}`} className="gap-1.5 px-4 py-2">
                <span>📄 {document.name ?? document.id}</span>
                <span className="rounded-full bg-[color:var(--color-cloud)]/80 px-1.5 py-0.2 text-[10px] font-semibold">
                  Doc
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <TabsContent value="overview" forceMount className="mt-4 space-y-8 data-[state=inactive]:hidden">
          {session.status === "synthesizing" ? (
            <div className="space-y-3 rounded-2xl border border-[color:var(--color-cloud)] bg-white p-6 shadow-xs" aria-busy="true" aria-live="polite">
              <Skeleton className="h-28 w-full" />
              <p className="text-xs font-medium text-[color:var(--color-steel)] animate-pulse">
                Synthesizing unified executive dashboard from these sources…
              </p>
            </div>
          ) : (
            <>
              {session.overview.config ? (
                <CombinedDashboardRenderer
                  config={session.overview.config}
                  datasetId={session.datasets[0]?.id}
                />
              ) : null}

              {findings.length > 0 ? (
                <CrossSourceConnectionsView findings={findings} tables={overviewTables} />
              ) : !session.overview.config ? (
                <EmptyState message="No genuine connections were found between these sources." />
              ) : null}
            </>
          )}
        </TabsContent>

        {session.datasets.map((dataset) => (
          <TabsContent key={dataset.id} value={`dataset-${dataset.id}`} forceMount className="mt-4 data-[state=inactive]:hidden">
            <DashboardRenderer datasetId={dataset.id} />
          </TabsContent>
        ))}

        {session.documents.map((document) => (
          <TabsContent key={document.id} value={`document-${document.id}`} forceMount className="mt-4 data-[state=inactive]:hidden">
            <DocumentSummaryRenderer documentId={document.id} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
};
