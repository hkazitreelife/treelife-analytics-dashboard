"use client";

import type {
  InsightSeverityValue,
  ResolvedDashboardInsightShape,
} from "@analytics/shared";

import { formatNumber } from "@/lib/aggregate";
import { EmptyState } from "@/components/ui/primitives";

/**
 * Severity drives colour, icon glyph and border weight, not just a text label,
 * so the four levels are distinguishable at a glance.
 */
const SEVERITY_STYLE: Record<
  InsightSeverityValue,
  { border: string; badgeBg: string; badgeText: string; glyph: string; label: string }
> = {
  positive: {
    border: "var(--color-risk-low)",
    badgeBg: "rgba(39, 174, 96, 0.12)",
    badgeText: "var(--color-risk-low)",
    glyph: "▲",
    label: "Positive",
  },
  negative: {
    border: "var(--color-risk-high)",
    badgeBg: "rgba(192, 57, 43, 0.12)",
    badgeText: "var(--color-risk-high)",
    glyph: "▼",
    label: "Negative",
  },
  warning: {
    border: "var(--color-risk-med)",
    badgeBg: "rgba(230, 126, 34, 0.14)",
    badgeText: "var(--color-risk-med)",
    glyph: "!",
    label: "Warning",
  },
  info: {
    border: "var(--color-cobalt)",
    badgeBg: "rgba(91, 141, 184, 0.14)",
    badgeText: "var(--color-cobalt)",
    glyph: "i",
    label: "Info",
  },
};

export const InsightsPanel = ({
  insights,
}: {
  insights: ResolvedDashboardInsightShape[];
}) => {
  if (insights.length === 0) {
    return <EmptyState message="No insights were generated for this dataset." />;
  }

  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {insights.map((insight) => {
        const style =
          SEVERITY_STYLE[insight.severity] ?? SEVERITY_STYLE.info;

        return (
          <li
            key={insight.insightId}
            data-severity={insight.severity}
            className="rounded-lg border border-[color:var(--color-cloud)] bg-white p-4 shadow-sm"
            style={{ borderLeft: `4px solid ${style.border}` }}
          >
            <div className="flex items-start gap-3">
              <span
                aria-hidden="true"
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold"
                style={{ background: style.badgeBg, color: style.badgeText }}
              >
                {style.glyph}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-[color:var(--color-forest)]">
                  {insight.finding}
                </p>

                {insight.metrics.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-3">
                    {insight.metrics.map((metric, index) => (
                      <div
                        key={`${metric.label}-${index}`}
                        className="rounded-md bg-[color:var(--color-cloud)] px-2.5 py-1.5"
                      >
                        <p className="text-base font-semibold leading-none text-[color:var(--color-forest)]">
                          {formatNumber(metric.value)}
                        </p>
                        <p className="mt-1 text-[11px] leading-none text-[color:var(--color-steel)]">
                          {metric.label}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : null}

                <p className="mt-2 text-sm leading-relaxed text-[color:var(--color-ink)]">
                  {insight.whyItMatters}
                </p>

                <p className="mt-2 flex items-start gap-1.5 text-sm leading-relaxed text-[color:var(--color-ink)]">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 shrink-0 text-xs font-bold"
                    style={{ color: style.badgeText }}
                  >
                    →
                  </span>
                  <span>{insight.recommendedAction}</span>
                </p>

                <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[color:var(--color-steel)]">
                  <span
                    className="rounded px-1.5 py-0.5 font-medium"
                    style={{ background: style.badgeBg, color: style.badgeText }}
                  >
                    {style.label}
                  </span>
                  {insight.relatedTables.length > 0 ? (
                    <span>{insight.relatedTables.join(", ")}</span>
                  ) : null}
                </p>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
};
