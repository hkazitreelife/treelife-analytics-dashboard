"use client";

import React, { useState } from "react";
import {
  type InsightSeverityValue,
  type ResolvedDashboardInsightShape,
} from "@analytics/shared";

import { formatNumber, resolveMetricValue } from "@/lib/aggregate";
import { EmptyState } from "@/components/ui/primitives";
import type { TableState } from "@/components/dashboard/WidgetRenderer";

type LegacyInsightShape = {
  insightId: string;
  title: string;
  body: string;
  severity: InsightSeverityValue;
  relatedTables: string[];
};

const isLegacyInsight = (insight: unknown): insight is LegacyInsightShape =>
  typeof insight === "object" &&
  insight !== null &&
  "title" in insight &&
  "body" in insight &&
  !("finding" in insight);

const isCurrentInsight = (
  insight: unknown,
): insight is ResolvedDashboardInsightShape =>
  typeof insight === "object" && insight !== null && "finding" in insight;

const SEVERITY_CONFIG: Record<
  InsightSeverityValue,
  {
    border: string;
    headerBg: string;
    badgeBg: string;
    badgeText: string;
    glyph: string;
    label: string;
    actionBg: string;
    actionBorder: string;
    statusBadge: string;
  }
> = {
  positive: {
    border: "rgba(16, 185, 129, 0.3)",
    headerBg: "rgba(16, 185, 129, 0.08)",
    badgeBg: "rgba(16, 185, 129, 0.15)",
    badgeText: "#047857",
    glyph: "✓",
    label: "Positive Metric",
    actionBg: "rgba(16, 185, 129, 0.05)",
    actionBorder: "rgba(16, 185, 129, 0.2)",
    statusBadge: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  negative: {
    border: "rgba(239, 68, 68, 0.3)",
    headerBg: "rgba(239, 68, 68, 0.08)",
    badgeBg: "rgba(239, 68, 68, 0.15)",
    badgeText: "#b91c1c",
    glyph: "✕",
    label: "Risk Factor",
    actionBg: "rgba(239, 68, 68, 0.05)",
    actionBorder: "rgba(239, 68, 68, 0.2)",
    statusBadge: "bg-red-50 text-red-700 border-red-200",
  },
  warning: {
    border: "rgba(245, 158, 11, 0.3)",
    headerBg: "rgba(245, 158, 11, 0.08)",
    badgeBg: "rgba(245, 158, 11, 0.15)",
    badgeText: "#b45309",
    glyph: "!",
    label: "Needs Attention",
    actionBg: "rgba(245, 158, 11, 0.05)",
    actionBorder: "rgba(245, 158, 11, 0.2)",
    statusBadge: "bg-amber-50 text-amber-700 border-amber-200",
  },
  info: {
    border: "rgba(59, 130, 246, 0.3)",
    headerBg: "rgba(59, 130, 246, 0.08)",
    badgeBg: "rgba(59, 130, 246, 0.15)",
    badgeText: "#1d4ed8",
    glyph: "ℹ",
    label: "Strategic Info",
    actionBg: "rgba(59, 130, 246, 0.05)",
    actionBorder: "rgba(59, 130, 246, 0.2)",
    statusBadge: "bg-blue-50 text-blue-700 border-blue-200",
  },
};

export const InsightsPanel = ({
  insights,
  tables,
}: {
  insights: unknown[];
  tables?: Record<string, TableState>;
}) => {
  const [filterMode, setFilterMode] = useState<"all" | "actions" | "metrics" | "risks">("all");
  const [completedItems, setCompletedItems] = useState<Record<string, boolean>>({});

  if (!Array.isArray(insights) || insights.length === 0) {
    return <EmptyState message="No executive insights generated for this dataset." />;
  }

  const toggleComplete = (id: string) => {
    setCompletedItems((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const filteredInsights = insights.filter((raw) => {
    if (!isCurrentInsight(raw)) return filterMode === "all";
    if (filterMode === "actions") {
      return Boolean(raw.recommendedAction || raw.presentation?.shape === "tracker-item");
    }
    if (filterMode === "metrics") {
      return Array.isArray(raw.metrics) && raw.metrics.length > 0;
    }
    if (filterMode === "risks") {
      return raw.severity === "warning" || raw.severity === "negative";
    }
    return true;
  });

  return (
    <div className="space-y-4">
      {/* Interactive Category & Checklist Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 pb-1 border-b border-[color:var(--color-cloud)]/80">
        <div className="flex items-center gap-1.5 overflow-x-auto py-1">
          <button
            type="button"
            onClick={() => setFilterMode("all")}
            className={`cursor-pointer rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${
              filterMode === "all"
                ? "bg-[color:var(--color-forest)] text-white shadow-xs"
                : "bg-white text-[color:var(--color-steel)] border border-[color:var(--color-cloud)] hover:bg-slate-50"
            }`}
          >
            All Findings ({insights.length})
          </button>
          <button
            type="button"
            onClick={() => setFilterMode("actions")}
            className={`cursor-pointer rounded-lg px-3 py-1.5 text-xs font-bold transition-all flex items-center gap-1.5 ${
              filterMode === "actions"
                ? "bg-[color:var(--color-forest)] text-white shadow-xs"
                : "bg-white text-[color:var(--color-steel)] border border-[color:var(--color-cloud)] hover:bg-slate-50"
            }`}
          >
            <span>✓ Action Checklist</span>
          </button>
          <button
            type="button"
            onClick={() => setFilterMode("metrics")}
            className={`cursor-pointer rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${
              filterMode === "metrics"
                ? "bg-[color:var(--color-forest)] text-white shadow-xs"
                : "bg-white text-[color:var(--color-steel)] border border-[color:var(--color-cloud)] hover:bg-slate-50"
            }`}
          >
            # Key Metrics & Numbers
          </button>
          <button
            type="button"
            onClick={() => setFilterMode("risks")}
            className={`cursor-pointer rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${
              filterMode === "risks"
                ? "bg-amber-600 text-white shadow-xs"
                : "bg-white text-[color:var(--color-steel)] border border-[color:var(--color-cloud)] hover:bg-slate-50"
            }`}
          >
            ⚠ Attention & Risks
          </button>
        </div>

        <div className="text-[11px] font-semibold text-[color:var(--color-steel)] shrink-0">
          {Object.values(completedItems).filter(Boolean).length} of {insights.length} Actions Completed
        </div>
      </div>

      {/* Grid of Executive Insights */}
      <ul className="grid gap-3 sm:gap-4 grid-cols-1 md:grid-cols-2">
        {filteredInsights.map((rawInsight, idx) => {
          if (isLegacyInsight(rawInsight)) {
            const insight = rawInsight;
            const style = SEVERITY_CONFIG[insight.severity] ?? SEVERITY_CONFIG.info;

            return (
              <li
                key={insight.insightId || idx}
                data-severity={insight.severity}
                className="group flex flex-col justify-between overflow-hidden rounded-2xl border border-[color:var(--color-cloud)] bg-white p-4 sm:p-5 shadow-xs transition-all duration-200 hover:shadow-md"
              >
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                    style={{ background: style.badgeBg, color: style.badgeText }}
                  >
                    {style.glyph}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-[color:var(--color-forest)]">
                      {insight.title}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-[color:var(--color-ink)]">
                      {insight.body}
                    </p>
                  </div>
                </div>
              </li>
            );
          }

          if (!isCurrentInsight(rawInsight)) {
            return null;
          }

          const insight = rawInsight;
          const id = insight.insightId || `ins_${idx}`;
          const isDone = completedItems[id] ?? false;
          const style = SEVERITY_CONFIG[insight.severity] ?? SEVERITY_CONFIG.info;
          const pres = (insight as any).presentation;
          const owner = pres?.owner || "Leadership";
          const status = pres?.status || (insight.severity === "warning" ? "Action Required" : "Tracked");

          return (
            <li
              key={id}
              data-severity={insight.severity}
              className={`group flex flex-col justify-between overflow-hidden rounded-2xl border bg-white shadow-xs transition-all duration-200 hover:shadow-md ${
                isDone
                  ? "border-emerald-300/80 bg-emerald-50/20 opacity-80"
                  : "border-[color:var(--color-cloud)] hover:border-[color:var(--color-steel-light)]/40"
              }`}
            >
              {/* Executive Accent Header */}
              <div
                className="flex items-center justify-between px-4 py-2.5 border-b border-[color:var(--color-cloud)]/70"
                style={{ background: isDone ? "rgba(16, 185, 129, 0.12)" : style.headerBg }}
              >
                <div className="flex items-center gap-2">
                  {/* Interactive Checklist Checkbox */}
                  <button
                    type="button"
                    onClick={() => toggleComplete(id)}
                    aria-label={`Mark insight ${id} completed`}
                    className={`cursor-pointer flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-xs font-black transition-all ${
                      isDone
                        ? "bg-emerald-600 border-emerald-700 text-white shadow-xs"
                        : "bg-white border-[color:var(--color-steel-light)] text-transparent hover:border-emerald-600 hover:text-emerald-600"
                    }`}
                  >
                    ✓
                  </button>

                  <span
                    className={`text-[11px] font-extrabold uppercase tracking-wider ${
                      isDone ? "text-emerald-800 line-through" : ""
                    }`}
                    style={{ color: isDone ? undefined : style.badgeText }}
                  >
                    {isDone ? "Completed" : style.label}
                  </span>

                  {/* Status Badge */}
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold border ${style.statusBadge}`}
                  >
                    {isDone ? "Resolved" : status}
                  </span>
                </div>

                <div className="flex items-center gap-1.5">
                  {owner ? (
                    <span className="hidden sm:inline-block rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-[color:var(--color-steel)] border border-slate-200/80">
                      Owner: {owner}
                    </span>
                  ) : null}

                  {Array.isArray(insight.relatedTables) && insight.relatedTables.length > 0 ? (
                    <span className="rounded bg-white/90 px-1.5 py-0.5 text-[10px] font-bold text-[color:var(--color-forest)] border border-[color:var(--color-cloud)]">
                      {insight.relatedTables[0]}
                    </span>
                  ) : null}
                </div>
              </div>

              {/* Card Content Area */}
              <div className="p-4 sm:p-5 flex-1 flex flex-col gap-3">
                {/* Finding Headline */}
                <h4
                  className={`text-sm md:text-base font-extrabold leading-snug text-[color:var(--color-forest)] ${
                    isDone ? "line-through text-slate-500" : ""
                  }`}
                >
                  {insight.finding}
                </h4>

                {/* Big Live Tabular Numerals / Metric Badges */}
                {Array.isArray(insight.metrics) && insight.metrics.length > 0 ? (
                  <div className="flex flex-wrap gap-2 pt-0.5">
                    {insight.metrics.map((metric, metricIndex) => {
                      const resolvedVal = resolveMetricValue(metric, tables);
                      const formatted =
                        typeof resolvedVal === "number"
                          ? formatNumber(resolvedVal)
                          : resolvedVal !== null && resolvedVal !== undefined
                            ? String(resolvedVal)
                            : (metric as any).value ?? "—";
                      return (
                        <div
                          key={`${metric.label}-${metricIndex}`}
                          className="inline-flex flex-col rounded-xl border border-[color:var(--color-cloud)] bg-slate-50/80 px-3 py-1.5 shadow-2xs transition-all group-hover:bg-white group-hover:border-[color:var(--color-forest-bright)]/40"
                        >
                          <span className="font-mono text-sm md:text-base font-black tabular-nums leading-tight text-[color:var(--color-forest)]">
                            {formatted}
                          </span>
                          <span className="mt-0.5 text-[10px] font-extrabold leading-none text-[color:var(--color-steel)] uppercase tracking-wide">
                            {metric.label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : null}

                {/* Why It Matters Context */}
                <p className="text-xs leading-relaxed text-[color:var(--color-ink)] font-normal">
                  {insight.whyItMatters}
                </p>

                {/* Recommended Action Checklist Box */}
                {insight.recommendedAction ? (
                  <div
                    className={`mt-auto rounded-xl p-3 text-xs leading-relaxed border transition-all ${
                      isDone
                        ? "bg-emerald-50/50 border-emerald-200"
                        : "bg-slate-50/90 border-slate-200 hover:border-slate-300"
                    }`}
                  >
                    <div className="flex items-start gap-2.5">
                      <span
                        aria-hidden="true"
                        className="font-bold text-sm leading-none shrink-0 mt-0.5 text-[color:var(--color-forest)]"
                      >
                        →
                      </span>
                      <div>
                        <span className="font-extrabold text-[color:var(--color-forest)]">
                          Action Required:{" "}
                        </span>
                        <span className="text-[color:var(--color-ink)] font-medium">
                          {insight.recommendedAction}
                        </span>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
