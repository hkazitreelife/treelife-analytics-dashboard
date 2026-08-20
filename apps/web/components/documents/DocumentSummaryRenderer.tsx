"use client";

import { useEffect, useState } from "react";

import { Card, CardBody, EmptyState, ErrorState, Skeleton } from "@/components/ui/primitives";

/**
 * Section 10.0 Step 5. A distinct component, not a variant of
 * DashboardRenderer's widget grid: a narrative document has no tabs, no
 * widgets, no charts -- key points ranked by importance, each with its
 * verified supporting quote, is the whole picture.
 *
 * Impeccable critique 2026-08-13, P1 "duplicate, unsynchronized chat/edit
 * surfaces": this used to also carry its own embedded chat and prompt-edit
 * forms, doing the identical two actions ContextChatEditPanel.tsx's right
 * rail already does against the identical endpoints, with no shared
 * history between them. Per the critique's resolution (right rail
 * canonical), both are removed here; `refreshToken` lets the right rail
 * trigger a refetch after a successful edit without the
 * window.location.reload() it used before this fix.
 */

type KeyPointImportance = "critical" | "high" | "medium";

type KeyPoint = {
  pointId: string;
  statement: string;
  importance: KeyPointImportance;
  supportingSectionIds: string[];
  quote: string;
};

type SectionRef = { sectionId: string; heading: string };

type DocumentSummary = {
  version: number;
  keyPoints: KeyPoint[];
  sections: SectionRef[];
};

type DocumentInfo = {
  id: string;
  name: string;
  status: string;
  lastError: string | null;
};

type Phase =
  | { kind: "loading" }
  | { kind: "error"; title: string; detail?: string | null }
  | { kind: "ready"; document: DocumentInfo; summary: DocumentSummary };

const IMPORTANCE_ORDER: KeyPointImportance[] = ["critical", "high", "medium"];

/**
 * Impeccable critique 2026-08-13, P2 contrast finding: `border`/`badgeBg`
 * keep the original risk hue (decorative); `badgeText` -- the actual
 * rendered label text -- uses the darkened -text token variants so it
 * clears WCAG AA's 4.5:1 on white. critical/risk-high already passes
 * (5.44:1), no variant needed there.
 */
const IMPORTANCE_STYLE: Record<
  KeyPointImportance,
  { border: string; badgeBg: string; badgeText: string; label: string }
> = {
  critical: {
    border: "var(--color-risk-high)",
    badgeBg: "rgba(192, 57, 43, 0.12)",
    badgeText: "var(--color-risk-high)",
    label: "Critical",
  },
  high: {
    border: "var(--color-risk-med)",
    badgeBg: "rgba(230, 126, 34, 0.14)",
    badgeText: "var(--color-risk-med-text)",
    label: "High",
  },
  medium: {
    border: "var(--color-cobalt)",
    badgeBg: "rgba(91, 141, 184, 0.14)",
    badgeText: "var(--color-cobalt-text)",
    label: "Medium",
  },
};

import { fetchJsonCached } from "@/lib/clientCache";

export const DocumentSummaryRenderer = ({
  documentId,
  refreshToken,
}: {
  documentId: string;
  /** Bumped by the right rail after a successful edit, to refetch without a full page reload. */
  refreshToken?: number;
}) => {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  // documentId -> expand state, so "more from this section" on one point
  // doesn't disable every other button while it's pending.
  const [expandStatus, setExpandStatus] = useState<
    | { kind: "idle" }
    | { kind: "pending"; focusSectionId: string | null }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const load = async (): Promise<void> => {
    setPhase({ kind: "loading" });

    try {
      const ttl = refreshToken && refreshToken > 0 ? 0 : 60_000;
      const [document, summary] = await Promise.all([
        fetchJsonCached<DocumentInfo>(`/api/documents/${documentId}`, ttl),
        fetchJsonCached<DocumentSummary>(`/api/documents/${documentId}/summary`, ttl),
      ]);

      setPhase({ kind: "ready", document, summary });
    } catch (error: unknown) {
      setPhase({
        kind: "error",
        title: "Could not load this document",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  useEffect(() => {
    void load();
    // Re-fetches when documentId changes, or when the right rail bumps
    // refreshToken after a successful edit; the expand action below
    // reloads explicitly on its own success instead of depending on this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, refreshToken]);

  const runExpand = async (focusSectionId: string | null): Promise<void> => {
    setExpandStatus({ kind: "pending", focusSectionId });

    try {
      const response = await fetch(`/api/documents/${documentId}/expand`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(focusSectionId ? { focusSectionId } : {}),
      });

      const body = (await response.json()) as { error?: string };

      if (!response.ok) {
        setExpandStatus({
          kind: "error",
          message: body.error ?? `Request returned ${response.status}.`,
        });
        return;
      }

      setExpandStatus({ kind: "idle" });
      await load();
    } catch (error: unknown) {
      setExpandStatus({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  if (phase.kind === "loading") {
    return (
      <div className="space-y-4" aria-busy="true" aria-live="polite">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (phase.kind === "error") {
    return <ErrorState title={phase.title} detail={phase.detail} />;
  }

  const { document, summary } = phase;
  const sectionHeadingById = new Map(
    summary.sections.map((section) => [section.sectionId, section.heading]),
  );

  const groupedPoints = IMPORTANCE_ORDER.map((importance) => ({
    importance,
    points: summary.keyPoints.filter((point) => point.importance === importance),
  })).filter((group) => group.points.length > 0);

  return (
    <div className="space-y-6">
      {/* Section 10.0 Step 5: exact, unmissable banner text, not a tooltip or a console log. */}
      <div
        role="status"
        className="rounded-lg border-2 p-4 text-sm font-medium"
        style={{
          borderColor: "var(--color-cobalt)",
          background: "rgba(91, 141, 184, 0.1)",
          color: "var(--color-ink)",
        }}
      >
        This document has no tabular data. Showing an AI-generated summary of
        key points instead of charts.
      </div>

      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-[color:var(--color-forest)]">
            {document.name}
          </h1>
          <p className="mt-1 text-sm text-[color:var(--color-steel)]">
            {summary.keyPoints.length} key point{summary.keyPoints.length === 1 ? "" : "s"} ·
            summary v{summary.version}
          </p>
        </div>

        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex items-center gap-1.5 rounded-xl border border-[color:var(--color-cloud)] bg-white px-3 py-1.5 text-xs font-bold text-[color:var(--color-forest)] shadow-2xs hover:border-[color:var(--color-forest-bright)] hover:bg-[color:var(--color-forest-surface)] active:scale-95 transition-all self-start sm:self-auto no-print"
        >
          <span>📄</span>
          <span>Export PDF Summary</span>
        </button>
      </header>

      {summary.keyPoints.length === 0 ? (
        <EmptyState message="No key points were generated for this document." />
      ) : (
        <div className="space-y-5">
          {groupedPoints.map((group) => {
            const style = IMPORTANCE_STYLE[group.importance];

            return (
              <section key={group.importance} className="space-y-3">
                <h2
                  className="text-sm font-semibold uppercase tracking-wide"
                  style={{ color: style.badgeText }}
                >
                  {style.label}
                </h2>
                <ul className="grid gap-3 grid-cols-1 md:grid-cols-2">
                  {group.points.map((point) => (
                    <li key={point.pointId}>
                      <Card className="transition-all duration-200 hover:border-[color:var(--color-cloud)] hover:shadow-xs">
                        <CardBody>
                          <div className="flex items-center justify-between gap-2 mb-2">
                            <span
                              className="rounded-md px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider"
                              style={{ background: style.badgeBg, color: style.badgeText }}
                            >
                              {style.label}
                            </span>
                            {point.supportingSectionIds.length > 0 ? (
                              <span className="text-[11px] font-medium text-[color:var(--color-steel)] truncate max-w-[200px]">
                                {point.supportingSectionIds
                                  .map((id) => sectionHeadingById.get(id) ?? id)
                                  .join(", ")}
                              </span>
                            ) : null}
                          </div>
                          <p className="text-sm font-semibold text-[color:var(--color-forest)] leading-snug">
                            {point.statement}
                          </p>
                          <blockquote className="mt-2.5 rounded-lg bg-[color:var(--color-warm-white)] p-2.5 border border-[color:var(--color-cloud)] text-xs italic leading-relaxed text-[color:var(--color-ink)]">
                            &ldquo;{point.quote}&rdquo;
                          </blockquote>
                          {point.supportingSectionIds.length > 0 ? (
                            <div className="mt-3 flex items-center justify-end">
                              <button
                                type="button"
                                disabled={expandStatus.kind === "pending"}
                                onClick={() => void runExpand(point.supportingSectionIds[0]!)}
                                className="rounded-lg px-2.5 py-1 text-xs font-semibold shadow-2xs hover:opacity-90 disabled:opacity-50 transition-opacity cursor-pointer"
                                style={{ background: style.badgeBg, color: style.badgeText }}
                              >
                                {expandStatus.kind === "pending" &&
                                expandStatus.focusSectionId === point.supportingSectionIds[0]
                                  ? "Finding more…"
                                  : "More from this part"}
                              </button>
                            </div>
                          ) : null}
                        </CardBody>
                      </Card>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[color:var(--color-cloud)] bg-white p-3">
        <button
          type="button"
          disabled={expandStatus.kind === "pending"}
          onClick={() => void runExpand(null)}
          className="rounded-md bg-[color:var(--color-forest)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {expandStatus.kind === "pending" && expandStatus.focusSectionId === null
            ? "Finding more…"
            : "Give me more"}
        </button>
        {expandStatus.kind === "error" ? (
          <span role="alert" className="text-xs text-[color:var(--color-risk-high)]">
            {expandStatus.message}
          </span>
        ) : null}
      </div>
    </div>
  );
};
