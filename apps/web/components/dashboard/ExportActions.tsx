"use client";

import { useState, useRef, useEffect } from "react";
import {
  exportDashboardToHtml,
  exportDashboardToPptx,
  exportRowsToCsv,
  exportWidgetToPng,
  exportWidgetToSvg,
  triggerPrintReport,
} from "@/lib/exports";

export type DashboardExportProps = {
  title: string;
  datasetName?: string;
  tables?: Record<string, { rows?: Record<string, unknown>[]; columns?: { name: string }[] }>;
};

export const DashboardExportBar = ({
  title,
  datasetName,
  tables,
}: DashboardExportProps) => {
  const [open, setOpen] = useState(false);
  const [isExportingPptx, setIsExportingPptx] = useState(false);
  const [isExportingHtml, setIsExportingHtml] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [open]);

  const handleExportAllCsv = () => {
    if (!tables) {
      alert("No data available to export.");
      return;
    }

    const tableNames = Object.keys(tables);
    if (tableNames.length === 0) {
      alert("No tables available.");
      return;
    }

    for (const tableName of tableNames) {
      const t = tables[tableName];
      if (t?.rows && t.rows.length > 0) {
        exportRowsToCsv(
          `${datasetName || "dataset"}-${tableName}-export.csv`,
          t.rows,
          t.columns?.map((c) => c.name),
        );
      }
    }
  };

  const handleExportPptx = async () => {
    try {
      setIsExportingPptx(true);
      await exportDashboardToPptx({ title, datasetName });
    } catch (err: unknown) {
      console.error("PPTX export failed:", err);
      alert("Failed to export PowerPoint presentation.");
    } finally {
      setIsExportingPptx(false);
    }
  };

  const handleExportHtml = async () => {
    try {
      setIsExportingHtml(true);
      await exportDashboardToHtml({ title, datasetName });
    } catch (err: unknown) {
      console.error("HTML export failed:", err);
      alert("Failed to export HTML report.");
    } finally {
      setIsExportingHtml(false);
    }
  };

  const isBusy = isExportingHtml || isExportingPptx;

  return (
    <div className="relative no-print" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={isBusy}
        className="inline-flex items-center gap-2 rounded-xl border border-[color:var(--color-cloud)] bg-white px-3.5 py-1.5 text-xs font-bold text-[color:var(--color-forest)] shadow-2xs hover:border-[color:var(--color-forest-bright)] hover:bg-[color:var(--color-forest-surface)] active:scale-95 transition-all disabled:opacity-50"
      >
        <span>📥</span>
        <span>
          {isExportingHtml
            ? "Exporting HTML…"
            : isExportingPptx
              ? "Exporting PPTX…"
              : "Export"}
        </span>
        <span className={`text-[10px] transition-transform duration-200 ${open ? "rotate-180" : ""}`}>
          ▼
        </span>
      </button>

      {open ? (
        <div className="absolute right-0 top-full mt-2 z-50 w-64 rounded-2xl border border-[color:var(--color-cloud)] bg-white p-1.5 shadow-xl space-y-1 text-xs animate-in fade-in zoom-in-95 duration-150">
          <div className="px-3 py-1.5 text-[10px] font-bold text-[color:var(--color-steel)] uppercase tracking-wider border-b border-[color:var(--color-cloud)]/70">
            Export Options
          </div>

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              void handleExportHtml();
            }}
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left font-semibold text-[color:var(--color-ink)] hover:bg-[color:var(--color-forest-surface)] hover:text-[color:var(--color-forest)] transition-colors cursor-pointer"
          >
            <span className="text-base">🌐</span>
            <div>
              <div className="font-bold">Full HTML Dashboard</div>
              <div className="text-[10px] text-[color:var(--color-steel)] font-normal">
                Standalone & offline-ready snapshot
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              triggerPrintReport();
            }}
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left font-semibold text-[color:var(--color-ink)] hover:bg-[color:var(--color-forest-surface)] hover:text-[color:var(--color-forest)] transition-colors cursor-pointer"
          >
            <span className="text-base">📄</span>
            <div>
              <div className="font-bold">Executive Report (PDF)</div>
              <div className="text-[10px] text-[color:var(--color-steel)] font-normal">
                Print or save PDF via browser
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              void handleExportPptx();
            }}
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left font-semibold text-[color:var(--color-ink)] hover:bg-[color:var(--color-forest-surface)] hover:text-[color:var(--color-forest)] transition-colors cursor-pointer"
          >
            <span className="text-base">📊</span>
            <div>
              <div className="font-bold">PowerPoint Deck (PPTX)</div>
              <div className="text-[10px] text-[color:var(--color-steel)] font-normal">
                Executive presentation deck
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              handleExportAllCsv();
            }}
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left font-semibold text-[color:var(--color-ink)] hover:bg-[color:var(--color-cloud-light)] transition-colors border-t border-[color:var(--color-cloud)]/70 mt-1 cursor-pointer"
          >
            <span className="text-base">📈</span>
            <div>
              <div className="font-bold">Raw CSV Data</div>
              <div className="text-[10px] text-[color:var(--color-steel)] font-normal">
                Export all spreadsheet sheets
              </div>
            </div>
          </button>
        </div>
      ) : null}
    </div>
  );
};

export const WidgetExportButton = ({
  widgetId,
  title,
  rows,
  columns,
}: {
  widgetId: string;
  title: string;
  rows?: Record<string, unknown>[];
  columns?: { name: string }[];
}) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const getContainer = (): HTMLElement | null => {
    return document.querySelector(`[data-widget-id="${widgetId}"]`);
  };

  const handleExportPng = () => {
    const el = getContainer();
    if (el) {
      exportWidgetToPng(el, `${title.toLowerCase().replace(/[^a-z0-9]/g, "_")}-300dpi`);
    }
  };

  const handleExportSvg = () => {
    const el = getContainer();
    if (el) {
      exportWidgetToSvg(el, `${title.toLowerCase().replace(/[^a-z0-9]/g, "_")}-vector`);
    }
  };

  const handleExportCsv = () => {
    if (rows && rows.length > 0) {
      exportRowsToCsv(
        `${title.toLowerCase().replace(/[^a-z0-9]/g, "_")}-data.csv`,
        rows,
        columns?.map((c) => c.name),
      );
    } else {
      alert("No tabular rows available for this widget.");
    }
  };

  return (
    <div className="relative no-print" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title="Export Chart/Data"
        className="flex h-6 w-6 items-center justify-center rounded-md border border-[color:var(--color-cloud)] bg-white text-[10px] font-bold text-[color:var(--color-steel)] hover:border-[color:var(--color-forest-bright)] hover:text-[color:var(--color-forest)] transition-all shadow-2xs"
      >
        ⋮
      </button>

      {open ? (
        <div
          className="absolute right-0 top-full mt-1 z-30 w-36 rounded-xl border border-[color:var(--color-cloud)] bg-white p-1 shadow-md space-y-0.5 text-[11px] font-semibold"
          onMouseLeave={() => setOpen(false)}
        >
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              handleExportPng();
            }}
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[color:var(--color-ink)] hover:bg-[color:var(--color-cloud-light)]"
          >
            <span>🖼️</span>
            <span>PNG (300 DPI)</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              handleExportSvg();
            }}
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[color:var(--color-ink)] hover:bg-[color:var(--color-cloud-light)]"
          >
            <span>📐</span>
            <span>Vector SVG</span>
          </button>
          {rows && rows.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                handleExportCsv();
              }}
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[color:var(--color-ink)] hover:bg-[color:var(--color-cloud-light)]"
            >
              <span>📊</span>
              <span>Export CSV</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
