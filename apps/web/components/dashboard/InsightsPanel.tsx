"use client";

import React from "react";
import {
  excludeTotalRows,
  type InsightSeverityValue,
  type ResolvedDashboardInsightShape,
} from "@analytics/shared";

import { applyWidgetFilters, formatNumber, resolveMetricValue, toNumber } from "@/lib/aggregate";
import { EmptyState } from "@/components/ui/primitives";
import type { TableState } from "@/components/dashboard/WidgetRenderer";

/**
 * Section 9.2 item 6: a config written before Section 9.1 stores insights in
 * the old {title, body} shape, not {finding, metrics, whyItMatters,
 * recommendedAction}.
 */
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
  }
> = {
  positive: {
    border: "rgba(16, 185, 129, 0.25)",
    headerBg: "rgba(16, 185, 129, 0.06)",
    badgeBg: "rgba(16, 185, 129, 0.15)",
    badgeText: "#047857",
    glyph: "↑",
    label: "Positive",
    actionBg: "rgba(16, 185, 129, 0.05)",
    actionBorder: "rgba(16, 185, 129, 0.2)",
  },
  negative: {
    border: "rgba(239, 68, 68, 0.25)",
    headerBg: "rgba(239, 68, 68, 0.06)",
    badgeBg: "rgba(239, 68, 68, 0.15)",
    badgeText: "#b91c1c",
    glyph: "↓",
    label: "Risk / Negative",
    actionBg: "rgba(239, 68, 68, 0.05)",
    actionBorder: "rgba(239, 68, 68, 0.2)",
  },
  warning: {
    border: "rgba(245, 158, 11, 0.25)",
    headerBg: "rgba(245, 158, 11, 0.06)",
    badgeBg: "rgba(245, 158, 11, 0.15)",
    badgeText: "#b45309",
    glyph: "!",
    label: "Attention Needed",
    actionBg: "rgba(245, 158, 11, 0.05)",
    actionBorder: "rgba(245, 158, 11, 0.2)",
  },
  info: {
    border: "rgba(59, 130, 246, 0.25)",
    headerBg: "rgba(59, 130, 246, 0.06)",
    badgeBg: "rgba(59, 130, 246, 0.15)",
    badgeText: "#1d4ed8",
    glyph: "i",
    label: "Strategic Info",
    actionBg: "rgba(59, 130, 246, 0.05)",
    actionBorder: "rgba(59, 130, 246, 0.2)",
  },
};

export const InsightsPanel = ({
  insights,
  tables,
}: {
  insights: unknown[];
  tables?: Record<string, TableState>;
}) => {
  if (insights.length === 0) {
    return <EmptyState message="No insights were generated for this dataset." />;
  }

  return (
    <ul className="grid gap-3 sm:gap-4 grid-cols-1 md:grid-cols-2">
      {insights.map((rawInsight, idx) => {
        if (isLegacyInsight(rawInsight)) {
          const insight = rawInsight;
          const style = SEVERITY_CONFIG[insight.severity] ?? SEVERITY_CONFIG.info;

          return (
            <li
              key={insight.insightId || idx}
              data-severity={insight.severity}
              data-legacy-shape="true"
              className="group flex flex-col justify-between overflow-hidden rounded-xl border border-[color:var(--color-cloud)] bg-white p-4 shadow-xs transition-all duration-200 hover:shadow-md"
            >
              <div className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold shadow-2xs"
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
                  <div className="mt-3 flex flex-wrap items-center gap-2 pt-2 border-t border-[color:var(--color-cloud)]/60 text-[11px] text-[color:var(--color-steel)]">
                    <span
                      className="rounded-full px-2 py-0.5 font-semibold text-[10px]"
                      style={{ background: style.badgeBg, color: style.badgeText }}
                    >
                      {style.label}
                    </span>
                    <span className="italic text-[10px]">
                      Legacy format · regenerate to update
                    </span>
                    {insight.relatedTables.length > 0 ? (
                      <span className="ml-auto text-[10px] text-[color:var(--color-steel-light)]">
                        {insight.relatedTables.join(", ")}
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
            </li>
          );
        }

        if (!isCurrentInsight(rawInsight)) {
          return null;
        }

        const insight = rawInsight;
        const style = SEVERITY_CONFIG[insight.severity] ?? SEVERITY_CONFIG.info;

        return (
          <li
            key={insight.insightId || idx}
            data-severity={insight.severity}
            className="group flex flex-col justify-between overflow-hidden rounded-2xl border border-[color:var(--color-cloud)] bg-white shadow-xs transition-all duration-200 hover:border-[color:var(--color-steel-light)]/40 hover:shadow-md"
          >
            {/* Tinted Accent Top Bar */}
            <div
              className="flex items-center justify-between px-4 py-2.5 border-b border-[color:var(--color-cloud)]/70"
              style={{ background: style.headerBg }}
            >
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-extrabold shadow-2xs"
                  style={{ background: style.badgeBg, color: style.badgeText }}
                >
                  {style.glyph}
                </span>
                <span
                  className="text-xs font-bold uppercase tracking-wider"
                  style={{ color: style.badgeText }}
                >
                  {style.label}
                </span>
              </div>

              {insight.relatedTables.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {insight.relatedTables.map((tbl) => (
                    <span
                      key={tbl}
                      className="rounded bg-white/80 px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--color-steel)] border border-[color:var(--color-cloud)]"
                    >
                      {tbl}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>

            {/* Card Content Area */}
            <div className="p-4 sm:p-5 flex-1 flex flex-col gap-3.5">
              {/* Finding Headline */}
              <h4 className="text-sm md:text-base font-extrabold leading-snug text-[color:var(--color-forest)]">
                {insight.finding}
              </h4>

              {/* Metric Chips with Tabular Numerals */}
              {insight.metrics.length > 0 ? (
                <div className="flex flex-wrap gap-2 pt-0.5">
                  {insight.metrics.map((metric, metricIndex) => {
                    const resolvedVal = resolveMetricValue(metric, tables);
                    const formatted =
                      typeof resolvedVal === "number"
                        ? formatNumber(resolvedVal)
                        : resolvedVal !== null && resolvedVal !== undefined
                          ? String(resolvedVal)
                          : "n/a";
                    return (
                      <div
                        key={`${metric.label}-${metricIndex}`}
                        className="inline-flex flex-col rounded-xl border border-[color:var(--color-cloud)] bg-[color:var(--color-cloud-light)]/80 px-3 py-1.5 shadow-2xs transition-all duration-150 group-hover:bg-white group-hover:border-[color:var(--color-forest-bright)]/30"
                      >
                        <span className="font-mono text-sm md:text-base font-black tabular-nums leading-tight text-[color:var(--color-forest)]">
                          {formatted}
                        </span>
                        <span className="mt-0.5 text-[10px] font-bold leading-none text-[color:var(--color-steel)] uppercase tracking-wide">
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

              {/* High-Contrast Recommended Action Box */}
              {insight.recommendedAction ? (
                <div
                  className="mt-auto rounded-xl p-3.5 text-xs leading-relaxed border transition-colors shadow-2xs"
                  style={{
                    background: style.actionBg,
                    borderColor: style.actionBorder,
                  }}
                >
                  <div className="flex items-start gap-2.5">
                    <span
                      aria-hidden="true"
                      className="font-bold text-sm leading-none shrink-0 mt-0.5"
                      style={{ color: style.badgeText }}
                    >
                      →
                    </span>
                    <div>
                      <span className="font-extrabold text-[color:var(--color-forest)]">
                        Recommended Action:{" "}
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
  );
};

