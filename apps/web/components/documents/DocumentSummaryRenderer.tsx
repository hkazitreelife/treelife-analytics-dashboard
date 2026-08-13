"use client";

import { useEffect, useState } from "react";

import { Card, CardBody, EmptyState, ErrorState, Skeleton } from "@/components/ui/primitives";

/**
 * Section 10.0 Step 5. A distinct component, not a variant of
 * DashboardRenderer's widget grid: a narrative document has no tabs, no
 * widgets, no charts -- key points ranked by importance, each with its
 * verified supporting quote, is the whole picture.
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
    badgeText: "var(--color-risk-med)",
    label: "High",
  },
  medium: {
    border: "var(--color-cobalt)",
    badgeBg: "rgba(91, 141, 184, 0.14)",
    badgeText: "var(--color-cobalt)",
    label: "Medium",
  },
};

export const DocumentSummaryRenderer = ({ documentId }: { documentId: string }) => {
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
      const [documentResponse, summaryResponse] = await Promise.all([
        fetch(`/api/documents/${documentId}`, { credentials: "include" }),
        fetch(`/api/documents/${documentId}/summary`, { credentials: "include" }),
      ]);

      if (documentResponse.status === 401 || summaryResponse.status === 401) {
        setPhase({
          kind: "error",
          title: "Not signed in",
          detail: "Sign in at /login, then reload this page.",
        });
        return;
      }

      if (!documentResponse.ok) {
        const body = (await documentResponse.json()) as { error?: string };
        setPhase({
          kind: "error",
          title: "Document not found",
          detail: body.error ?? `GET /api/documents/${documentId} returned ${documentResponse.status}.`,
        });
        return;
      }

      const document = (await documentResponse.json()) as DocumentInfo;

      if (!summaryResponse.ok) {
        const body = (await summaryResponse.json()) as { error?: string };
        setPhase({
          kind: "error",
          title:
            document.status === "failed"
              ? `"${document.name}" failed to process`
              : "No summary available yet",
          detail:
            document.status === "failed"
              ? (document.lastError ?? "No summary is available for this document.")
              : (body.error ?? `GET /api/documents/${documentId}/summary returned ${summaryResponse.status}.`),
        });
        return;
      }

      const summary = (await summaryResponse.json()) as DocumentSummary;

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
    // Re-fetches only when the documentId changes; the expand action below
    // reloads explicitly on success instead of polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

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

      <header>
        <h1 className="text-xl font-semibold text-[color:var(--color-forest)]">
          {document.name}
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-steel)]">
          {summary.keyPoints.length} key point{summary.keyPoints.length === 1 ? "" : "s"} ·
          summary v{summary.version}
        </p>
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
                <ul className="grid gap-3 md:grid-cols-2">
                  {group.points.map((point) => (
                    <li key={point.pointId}>
                      <Card style={{ borderLeft: `4px solid ${style.border}` }}>
                        <CardBody>
                          <p className="text-sm font-semibold text-[color:var(--color-forest)]">
                            {point.statement}
                          </p>
                          <blockquote className="mt-2 border-l-2 border-[color:var(--color-cloud)] pl-2 text-xs italic leading-relaxed text-[color:var(--color-steel)]">
                            &ldquo;{point.quote}&rdquo;
                          </blockquote>
                          {point.supportingSectionIds.length > 0 ? (
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <span className="text-xs text-[color:var(--color-steel)]">
                                {point.supportingSectionIds
                                  .map((id) => sectionHeadingById.get(id) ?? id)
                                  .join(", ")}
                              </span>
                              <button
                                type="button"
                                disabled={expandStatus.kind === "pending"}
                                onClick={() => void runExpand(point.supportingSectionIds[0]!)}
                                className="rounded px-2 py-0.5 text-xs font-medium disabled:opacity-50"
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
