"use client";

import { useState } from "react";
import { formatNumber, resolveMetricValue } from "@/lib/aggregate";

export type FindingMetric = {
  label: string;
  value?: number;
  kind?: "aggregate" | "row";
  sourceTable?: string;
  sourceField?: string;
  aggregation?: string;
  filter?: any;
  filters?: any[];
  labelColumn?: string;
  labelValue?: string;
  valueColumn?: string;
};

export type FindingItem = {
  finding: string;
  whyItMatters?: string;
  datasetId?: string;
  datasetName?: string;
  metric?: FindingMetric;
  metrics?: FindingMetric[];
  documentId?: string;
  documentName?: string;
  citation?: { sectionId?: string; quote?: string };
};

export const CrossSourceConnectionsView = ({
  findings,
  tables,
}: {
  findings: FindingItem[];
  tables?: Record<string, any>;
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [viewMode, setViewMode] = useState<"split" | "grid" | "checklist">("split");
  const [checkedIds, setCheckedIds] = useState<Record<number, boolean>>({});
  const [filterQuery, setFilterQuery] = useState("");

  if (findings.length === 0) return null;

  const toggleCheck = (idx: number, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setCheckedIds((prev) => ({ ...prev, [idx]: !prev[idx] }));
  };

  const getMetricDisplayValue = (m: FindingMetric): string => {
    const resolved = resolveMetricValue(m, tables);
    if (resolved !== null && Number.isFinite(resolved)) {
      return formatNumber(resolved);
    }
    if (m.value !== undefined && Number.isFinite(m.value)) {
      return formatNumber(m.value);
    }
    return "—";
  };

  const filteredFindings = findings.map((f, i) => ({ ...f, originalIndex: i })).filter((f) => {
    if (!filterQuery.trim()) return true;
    const q = filterQuery.toLowerCase();
    return (
      f.finding.toLowerCase().includes(q) ||
      (f.whyItMatters && f.whyItMatters.toLowerCase().includes(q)) ||
      (f.documentName && f.documentName.toLowerCase().includes(q)) ||
      (f.datasetName && f.datasetName.toLowerCase().includes(q)) ||
      (f.citation?.quote && f.citation.quote.toLowerCase().includes(q))
    );
  });

  const activeFinding = findings[selectedIndex] ?? findings[0];
  const activeIndex = selectedIndex;

  const getMetrics = (f: FindingItem): FindingMetric[] => {
    if (Array.isArray(f.metrics) && f.metrics.length > 0) return f.metrics;
    if (f.metric) return [f.metric];
    return [];
  };

  return (
    <section className="mt-8 border-t border-[color:var(--color-cloud)] pt-6 space-y-4">
      {/* Header with Title and Mode Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-2">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-[color:var(--color-grape)] text-white text-xs font-black shadow-xs">
            🔗
          </span>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-extrabold tracking-tight text-[color:var(--color-forest)]">
                Cross-Source Intelligence & Verification
              </h2>
              <span className="rounded-full bg-[color:var(--color-grape-surface)] px-2.5 py-0.5 text-[11px] font-bold text-[color:var(--color-grape)] border border-[color:var(--color-grape)]/20">
                {findings.length} Verified Links
              </span>
            </div>
            <p className="text-xs text-[color:var(--color-steel)] mt-0.5">
              Synthesis connecting quantitative spreadsheet rows with qualitative document statements
            </p>
          </div>
        </div>

        {/* Action Bar: Search & View Switcher */}
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="Search connections…"
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            className="rounded-xl border border-[color:var(--color-cloud)] bg-white px-3 py-1.5 text-xs text-[color:var(--color-ink)] placeholder-[color:var(--color-steel-light)] shadow-2xs focus:border-[color:var(--color-forest)] focus:outline-hidden"
          />

          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 rounded-xl border border-[color:var(--color-cloud)] bg-white px-3 py-1.5 text-xs font-bold text-[color:var(--color-forest)] shadow-2xs hover:border-[color:var(--color-forest-bright)] hover:bg-[color:var(--color-forest-surface)] active:scale-95 transition-all no-print"
            title="Export full executive report as PDF"
          >
            <span>📑</span>
            <span>Export Report</span>
          </button>

          <div className="flex items-center rounded-xl border border-[color:var(--color-cloud)] bg-[color:var(--color-cloud-light)] p-1 shadow-2xs no-print">
            <button
              type="button"
              onClick={() => setViewMode("split")}
              className={`rounded-lg px-2.5 py-1 text-xs font-bold transition-all ${
                viewMode === "split"
                  ? "bg-white text-[color:var(--color-forest)] shadow-xs"
                  : "text-[color:var(--color-steel)] hover:text-[color:var(--color-ink)]"
              }`}
            >
              📑 Inspector
            </button>
            <button
              type="button"
              onClick={() => setViewMode("checklist")}
              className={`rounded-lg px-2.5 py-1 text-xs font-bold transition-all ${
                viewMode === "checklist"
                  ? "bg-white text-[color:var(--color-forest)] shadow-xs"
                  : "text-[color:var(--color-steel)] hover:text-[color:var(--color-ink)]"
              }`}
            >
              ✓ Checklist
            </button>
            <button
              type="button"
              onClick={() => setViewMode("grid")}
              className={`rounded-lg px-2.5 py-1 text-xs font-bold transition-all ${
                viewMode === "grid"
                  ? "bg-white text-[color:var(--color-forest)] shadow-xs"
                  : "text-[color:var(--color-steel)] hover:text-[color:var(--color-ink)]"
              }`}
            >
              ⊞ Grid
            </button>
          </div>
        </div>
      </div>

      {/* VIEW MODE 1: SPLIT INSPECTOR (VERTICAL RECTANGULAR TABS + DETAIL INSPECTOR) */}
      {viewMode === "split" ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 min-h-[520px]">
          {/* Left Column: Vertical Rectangular List Tabs */}
          <div className="lg:col-span-5 flex flex-col gap-2 max-h-[640px] overflow-y-auto pr-1">
            {filteredFindings.map((f) => {
              const isSelected = f.originalIndex === activeIndex;
              const isChecked = checkedIds[f.originalIndex];
              const metrics = getMetrics(f);
              const primaryMetric = metrics[0];

              return (
                <div
                  key={f.originalIndex}
                  onClick={() => setSelectedIndex(f.originalIndex)}
                  className={`group relative flex cursor-pointer flex-col gap-2 rounded-2xl border p-3.5 transition-all duration-150 ${
                    isSelected
                      ? "border-[color:var(--color-grape)] bg-[color:var(--color-grape-surface)]/40 shadow-sm"
                      : "border-[color:var(--color-cloud)] bg-white hover:border-[color:var(--color-steel-light)]/50 hover:bg-[color:var(--color-cloud-light)]/30 hover:shadow-2xs"
                  }`}
                  style={{
                    borderLeftWidth: 4,
                    borderLeftColor: isSelected
                      ? "var(--color-grape)"
                      : isChecked
                        ? "var(--color-forest)"
                        : "var(--color-cloud)",
                  }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={(e) => toggleCheck(f.originalIndex, e)}
                        title={isChecked ? "Mark as unreviewed" : "Mark as verified"}
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-lg border transition-all ${
                          isChecked
                            ? "border-[color:var(--color-forest)] bg-[color:var(--color-forest)] text-white"
                            : "border-[color:var(--color-cloud)] bg-white text-transparent hover:border-[color:var(--color-steel)]"
                        }`}
                      >
                        ✓
                      </button>
                      <span className="text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-grape-text)]">
                        Connection #{f.originalIndex + 1}
                      </span>
                    </div>

                    {primaryMetric ? (
                      <span className="rounded-lg bg-white px-2 py-0.5 font-mono text-xs font-extrabold text-[color:var(--color-forest)] border border-[color:var(--color-cloud)] tabular-nums shadow-2xs">
                        {getMetricDisplayValue(primaryMetric)}
                      </span>
                    ) : null}
                  </div>

                  <h3 className={`text-xs font-bold leading-snug line-clamp-2 ${isSelected ? "text-[color:var(--color-forest)]" : "text-[color:var(--color-ink)]"}`}>
                    {f.finding}
                  </h3>

                  <div className="flex items-center justify-between gap-1 pt-1 text-[10px] text-[color:var(--color-steel)]">
                    <span className="truncate max-w-[140px] font-medium">
                      📊 {f.datasetName ?? "Dataset"}
                    </span>
                    <span className="truncate max-w-[140px] font-medium">
                      📄 {f.documentName ?? "Document"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Right Column: Deep-Dive Side-by-Side Comparator Card */}
          {activeFinding ? (
            <div className="lg:col-span-7 flex flex-col justify-between overflow-hidden rounded-2xl border border-[color:var(--color-cloud)] bg-white shadow-xs">
              {/* Card Header Bar */}
              <div className="flex items-center justify-between border-b border-[color:var(--color-cloud)]/80 bg-gradient-to-r from-[color:var(--color-grape-surface)] to-[color:var(--color-cloud-light)]/40 px-5 py-3">
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-xl bg-[color:var(--color-grape)] text-white text-xs font-bold shadow-2xs">
                    ✦
                  </span>
                  <span className="text-xs font-extrabold uppercase tracking-wider text-[color:var(--color-grape-text)]">
                    Executive Verified Connection #{activeIndex + 1}
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() => toggleCheck(activeIndex)}
                  className={`flex items-center gap-1.5 rounded-xl px-3 py-1 text-xs font-bold transition-all border ${
                    checkedIds[activeIndex]
                      ? "border-[color:var(--color-forest)] bg-[color:var(--color-forest-surface)] text-[color:var(--color-forest)]"
                      : "border-[color:var(--color-cloud)] bg-white text-[color:var(--color-steel)] hover:text-[color:var(--color-ink)]"
                  }`}
                >
                  <span>{checkedIds[activeIndex] ? "✓ Verified" : "○ Mark as Verified"}</span>
                </button>
              </div>

              {/* Main Content Area */}
              <div className="p-5 flex-1 flex flex-col gap-4">
                {/* Finding Headline */}
                <div>
                  <h3 className="text-base font-extrabold leading-snug text-[color:var(--color-forest)]">
                    {activeFinding.finding}
                  </h3>
                </div>

                {/* Side-by-Side Proof Comparison Box */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                  {/* Left: Quantitative Dataset Signal */}
                  <div className="flex flex-col justify-between rounded-xl border border-[color:var(--color-cobalt)]/25 bg-[color:var(--color-cobalt-surface)]/40 p-3.5 shadow-2xs">
                    <div>
                      <div className="flex items-center justify-between gap-1 pb-2 border-b border-[color:var(--color-cobalt)]/20">
                        <span className="text-[10px] font-extrabold uppercase tracking-wider text-[color:var(--color-cobalt-text)] flex items-center gap-1">
                          <span>📊</span> Quantitative Data
                        </span>
                        <span className="rounded bg-white px-1.5 py-0.5 text-[9px] font-bold text-[color:var(--color-steel)] border border-[color:var(--color-cloud)] truncate max-w-[120px]">
                          {activeFinding.datasetName ?? "Raw Data"}
                        </span>
                      </div>

                      {/* Primary Metrics */}
                      <div className="mt-3 flex flex-wrap gap-2">
                        {getMetrics(activeFinding).map((m, idx) => (
                          <div
                            key={idx}
                            className="flex flex-col rounded-xl bg-white p-2.5 border border-[color:var(--color-cobalt)]/20 shadow-2xs min-w-[110px]"
                          >
                            <span className="font-mono text-xl font-black text-[color:var(--color-forest)] tabular-nums">
                              {getMetricDisplayValue(m)}
                            </span>
                            <span className="mt-0.5 text-[10px] font-semibold text-[color:var(--color-steel)]">
                              {m.label ?? m.sourceField ?? "Metric"}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="mt-3 pt-2 border-t border-[color:var(--color-cobalt)]/15 text-[10px] font-medium text-[color:var(--color-steel)]">
                      {getMetrics(activeFinding)[0]?.sourceTable
                        ? `Table: ${getMetrics(activeFinding)[0]?.sourceTable}`
                        : "Verified against tabular exit records"}
                    </div>
                  </div>

                  {/* Right: Qualitative Document Citation OR Recommended Action */}
                  {activeFinding.citation?.quote ? (
                    <div className="flex flex-col justify-between rounded-xl border border-[color:var(--color-grape)]/25 bg-[color:var(--color-grape-surface)]/40 p-3.5 shadow-2xs">
                      <div>
                        <div className="flex items-center justify-between gap-1 pb-2 border-b border-[color:var(--color-grape)]/20">
                          <span className="text-xs font-extrabold uppercase tracking-wider text-[color:var(--color-grape-text)] flex items-center gap-1.5">
                            <span>📄</span> Document Citation
                          </span>
                          <span className="rounded-md bg-white px-2 py-0.5 text-[11px] font-semibold text-[color:var(--color-ink)] border border-[color:var(--color-cloud)] truncate max-w-[140px]">
                            {activeFinding.documentName ?? "Source Note"}
                          </span>
                        </div>

                        <blockquote className="mt-3 rounded-xl bg-white p-3 border border-[color:var(--color-grape)]/20 text-xs italic leading-relaxed text-[color:var(--color-ink)] shadow-2xs">
                          “{activeFinding.citation.quote}”
                        </blockquote>
                      </div>

                      {activeFinding.citation?.sectionId ? (
                        <div className="mt-3 pt-2 border-t border-[color:var(--color-grape)]/15 text-[11px] font-semibold text-[color:var(--color-grape-text)]">
                          Section: {activeFinding.citation.sectionId}
                        </div>
                      ) : null}
                    </div>
                  ) : (activeFinding as any).recommendedAction ? (
                    <div className="flex flex-col justify-between rounded-xl border border-[color:var(--color-forest-bright)]/25 bg-[color:var(--color-forest-surface)]/40 p-3.5 shadow-2xs">
                      <div>
                        <div className="flex items-center justify-between gap-1 pb-2 border-b border-[color:var(--color-forest-bright)]/20">
                          <span className="text-xs font-extrabold uppercase tracking-wider text-[color:var(--color-forest)] flex items-center gap-1.5">
                            <span>🎯</span> Recommended Policy
                          </span>
                          <span className="rounded-md bg-white px-2 py-0.5 text-[11px] font-bold text-[color:var(--color-forest)] border border-[color:var(--color-forest-bright)]/20">
                            Action Item
                          </span>
                        </div>

                        <p className="mt-3 rounded-xl bg-white p-3 border border-[color:var(--color-forest-bright)]/20 text-xs font-semibold leading-relaxed text-[color:var(--color-forest)] shadow-2xs">
                          {(activeFinding as any).recommendedAction}
                        </p>
                      </div>

                      <div className="mt-3 pt-2 border-t border-[color:var(--color-forest-bright)]/15 text-[11px] font-bold text-[color:var(--color-forest)]">
                        Target Quarter: Q1 / Active Requisition
                      </div>
                    </div>
                  ) : null}
                </div>

                {/* Why It Matters Callout Banner */}
                {activeFinding.whyItMatters ? (
                  <div className="rounded-xl border border-[color:var(--color-forest-bright)]/20 bg-[color:var(--color-forest-surface)]/50 p-3.5 text-xs leading-relaxed text-[color:var(--color-ink)]">
                    <div className="flex items-start gap-2">
                      <span className="text-sm font-extrabold text-[color:var(--color-forest)]">
                        💡
                      </span>
                      <div>
                        <span className="font-bold text-[color:var(--color-forest)]">
                          Strategic Implication:{" "}
                        </span>
                        <span className="font-medium text-[color:var(--color-ink)]">
                          {activeFinding.whyItMatters}
                        </span>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>

              {/* Navigation Footer Bar */}
              <div className="flex items-center justify-between border-t border-[color:var(--color-cloud)]/80 bg-[color:var(--color-cloud-light)]/40 px-5 py-2.5 text-xs">
                <button
                  type="button"
                  disabled={activeIndex <= 0}
                  onClick={() => setSelectedIndex(Math.max(0, activeIndex - 1))}
                  className="rounded-lg px-2.5 py-1 font-bold text-[color:var(--color-steel)] hover:bg-white hover:text-[color:var(--color-forest)] disabled:opacity-30 disabled:pointer-events-none transition-all"
                >
                  ← Previous
                </button>
                <span className="text-[11px] font-semibold text-[color:var(--color-steel)]">
                  {activeIndex + 1} of {findings.length}
                </span>
                <button
                  type="button"
                  disabled={activeIndex >= findings.length - 1}
                  onClick={() => setSelectedIndex(Math.min(findings.length - 1, activeIndex + 1))}
                  className="rounded-lg px-2.5 py-1 font-bold text-[color:var(--color-steel)] hover:bg-white hover:text-[color:var(--color-forest)] disabled:opacity-30 disabled:pointer-events-none transition-all"
                >
                  Next →
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* VIEW MODE 2: CHECKLIST MATRIX VIEW */}
      {viewMode === "checklist" ? (
        <div className="space-y-3">
          {filteredFindings.map((f) => {
            const isChecked = checkedIds[f.originalIndex];
            const metrics = getMetrics(f);

            return (
              <div
                key={f.originalIndex}
                className={`group rounded-2xl border transition-all duration-150 p-4 bg-white ${
                  isChecked
                    ? "border-[color:var(--color-forest)]/40 bg-[color:var(--color-forest-surface)]/20"
                    : "border-[color:var(--color-cloud)] hover:border-[color:var(--color-steel-light)]/50 shadow-2xs"
                }`}
              >
                <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
                  {/* Left Column: Checkbox & Finding Details */}
                  <div className="flex items-start gap-3 flex-1">
                    <button
                      type="button"
                      onClick={() => toggleCheck(f.originalIndex)}
                      className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-xl border text-xs font-bold transition-all ${
                        isChecked
                          ? "border-[color:var(--color-forest)] bg-[color:var(--color-forest)] text-white shadow-2xs"
                          : "border-[color:var(--color-cloud)] bg-white text-transparent hover:border-[color:var(--color-steel)]"
                      }`}
                    >
                      ✓
                    </button>
                    <div className="space-y-2 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[10px] font-extrabold uppercase tracking-wider text-[color:var(--color-grape-text)]">
                          Connection #{f.originalIndex + 1}
                        </span>
                        <span className="rounded-md bg-[color:var(--color-cobalt-surface)] px-1.5 py-0.5 text-[9px] font-bold text-[color:var(--color-cobalt-text)] border border-[color:var(--color-cobalt)]/20">
                          📊 {f.datasetName ?? "Dataset"}
                        </span>
                        <span className="rounded-md bg-[color:var(--color-grape-surface)] px-1.5 py-0.5 text-[9px] font-bold text-[color:var(--color-grape-text)] border border-[color:var(--color-grape)]/20">
                          📄 {f.documentName ?? "Document"}
                        </span>
                      </div>

                      <h4 className="text-sm font-bold text-[color:var(--color-forest)] leading-snug">
                        {f.finding}
                      </h4>

                      {f.whyItMatters ? (
                        <p className="text-xs leading-relaxed text-[color:var(--color-ink)]">
                          {f.whyItMatters}
                        </p>
                      ) : null}

                      {f.citation?.quote ? (
                        <div className="rounded-xl bg-[color:var(--color-warm-white)] p-3 border border-[color:var(--color-grape)]/20 text-xs italic text-[color:var(--color-ink)]">
                          “{f.citation.quote}”
                        </div>
                      ) : null}
                    </div>
                  </div>

                  {/* Right Column: Metric Chips */}
                  {metrics.length > 0 ? (
                    <div className="flex md:flex-col items-end gap-2 shrink-0">
                      {metrics.map((m, mIdx) => (
                        <div
                          key={mIdx}
                          className="flex flex-col items-end rounded-xl bg-[color:var(--color-cloud-light)]/70 px-3 py-1.5 border border-[color:var(--color-cloud)] min-w-[100px]"
                        >
                          <span className="font-mono text-base font-extrabold text-[color:var(--color-forest)] tabular-nums">
                            {getMetricDisplayValue(m)}
                          </span>
                          <span className="text-[10px] font-medium text-[color:var(--color-steel)] text-right">
                            {m.label ?? m.sourceField ?? "Metric"}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {/* VIEW MODE 3: 2-COLUMN GRID VIEW */}
      {viewMode === "grid" ? (
        <ul className="grid gap-4 md:grid-cols-2">
          {filteredFindings.map((f) => {
            const metrics = getMetrics(f);
            const isChecked = checkedIds[f.originalIndex];

            return (
              <li key={f.originalIndex}>
                <div className="group flex h-full flex-col justify-between overflow-hidden rounded-2xl border border-[color:var(--color-cloud)] bg-white shadow-xs transition-all duration-200 hover:border-[color:var(--color-grape)]/40 hover:shadow-md">
                  {/* Top Bar */}
                  <div className="flex items-center justify-between border-b border-[color:var(--color-cloud)]/70 bg-[color:var(--color-grape-surface)] px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-grape-text)]">
                        Verified Connection #{f.originalIndex + 1}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleCheck(f.originalIndex)}
                      className={`flex h-5 w-5 items-center justify-center rounded-lg border text-xs font-bold transition-all ${
                        isChecked
                          ? "border-[color:var(--color-forest)] bg-[color:var(--color-forest)] text-white"
                          : "border-[color:var(--color-cloud)] bg-white text-transparent hover:border-[color:var(--color-steel)]"
                      }`}
                    >
                      ✓
                    </button>
                  </div>

                  <div className="p-4 flex-1 flex flex-col gap-3">
                    <h4 className="text-sm font-bold text-[color:var(--color-forest)] leading-snug">
                      {f.finding}
                    </h4>

                    {f.whyItMatters ? (
                      <p className="text-xs leading-relaxed text-[color:var(--color-ink)]">
                        {f.whyItMatters}
                      </p>
                    ) : null}

                    {metrics.length > 0 ? (
                      <div className="flex flex-wrap gap-2 pt-1">
                        {metrics.map((m, mIdx) => (
                          <div
                            key={mIdx}
                            className="inline-flex items-baseline gap-1.5 rounded-xl bg-[color:var(--color-cloud-light)] px-3 py-1.5 text-xs border border-[color:var(--color-cloud)]"
                          >
                            <span className="font-mono font-extrabold text-[color:var(--color-forest)] tabular-nums">
                              {getMetricDisplayValue(m)}
                            </span>
                            <span className="text-[10px] text-[color:var(--color-steel)] font-medium">
                              {m.label ?? m.sourceField ?? "Metric"}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : null}

                    {f.citation?.quote ? (
                      <blockquote className="mt-auto rounded-xl bg-[color:var(--color-warm-white)] p-3 border border-[color:var(--color-grape)]/20 text-xs italic leading-relaxed text-[color:var(--color-ink)]">
                        “{f.citation.quote}”
                        {f.documentName ? (
                          <footer className="mt-1.5 not-italic text-[11px] font-bold text-[color:var(--color-grape-text)]">
                            — Source Document: {f.documentName}
                          </footer>
                        ) : null}
                      </blockquote>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
};
