"use client";

import React from "react";
import type { DashboardWidgetShape } from "@analytics/shared";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  buildCategorySeries,
  computeKpi,
  formatCell,
  formatNumber,
  resolveChartFields,
  type DataColumn,
  type DataRow,
} from "@/lib/aggregate";
import {
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  EmptyState,
  ErrorState,
  Skeleton,
} from "@/components/ui/primitives";

/**
 * Renders one widget from its config entry. It knows widget types, not datasets.
 * Every table name, column name and label comes from the config or the data
 * endpoint at runtime.
 */

export type TableState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      columns: DataColumn[];
      rows: DataRow[];
      totalRows: number;
    };

// Brand color palette constants matching globals.css theme tokens.
// Direct hex values ensure charts render correctly in SVG/PNG export and print contexts
// where external CSS variables are not evaluated.
const BRAND_CHART_COLORS = {
  forestMid: "#1a5c3a",
  cobalt: "#5b8db8",
  gold: "#d4a843",
  terracotta: "#c05e3c",
  grape: "#6b5ea8",
  forestBright: "#2e8b57",
  steel: "#4a5d73",
  cloud: "#e2e8f0",
} as const;

const COLOR_NAMES: Record<string, string> = {
  blue: "#3b82f6",
  cobalt: "#5b8db8",
  navy: "#1e3a8a",
  indigo: "#6366f1",
  cyan: "#06b6d4",
  teal: "#14b8a6",
  green: "#10b981",
  emerald: "#059669",
  forest: "#1a5c3a",
  forestbright: "#2e8b57",
  red: "#ef4444",
  rose: "#f43f5e",
  coral: "#f87171",
  orange: "#f97316",
  amber: "#f59e0b",
  gold: "#d4a843",
  yellow: "#eab308",
  purple: "#8b5cf6",
  violet: "#7c3aed",
  grape: "#6b5ea8",
  pink: "#ec4899",
  terracotta: "#c05e3c",
  steel: "#4a5d73",
  slate: "#64748b",
  gray: "#6b7280",
};

const SERIES_COLOURS = [
  BRAND_CHART_COLORS.forestMid,
  BRAND_CHART_COLORS.cobalt,
  BRAND_CHART_COLORS.gold,
  BRAND_CHART_COLORS.terracotta,
  BRAND_CHART_COLORS.grape,
  BRAND_CHART_COLORS.forestBright,
  BRAND_CHART_COLORS.steel,
];

const resolveSeriesColours = (widget: DashboardWidgetShape): string[] => {
  const customColor = (widget as any).color?.trim().toLowerCase();
  if (customColor) {
    if (customColor.startsWith("#") || customColor.startsWith("rgb")) {
      return [customColor, ...SERIES_COLOURS.filter((c) => c !== customColor)];
    }
    if (COLOR_NAMES[customColor]) {
      const hex = COLOR_NAMES[customColor];
      return [hex, ...SERIES_COLOURS.filter((c) => c !== hex)];
    }
  }
  return SERIES_COLOURS;
};

const axisStyle = { fontSize: 12, fontWeight: 600, fill: "#4a5d73" } as const;

/** Matches Recharts' wide ValueType so the signature stays assignable. */
const tooltipFormatter = (
  // Recharts' Formatter passes TValue | undefined, so undefined must be accepted
  // or the signature is not assignable.
  value: number | string | ReadonlyArray<number | string> | undefined,
): string => {
  if (typeof value === "number") {
    return formatNumber(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => formatCell(entry)).join(", ");
  }

  return formatCell(value);
};

const ChartFrame = ({ children }: { children: React.ReactElement }) => (
  <div className="h-[240px] min-h-[240px] max-h-[340px] w-full flex items-center justify-center py-1 print:h-[240px] print:min-h-[240px]">
    <ResponsiveContainer width="100%" height={240} minHeight={240} debounce={0}>
      {children}
    </ResponsiveContainer>
  </div>
);

const WidgetBody = ({
  widget,
  state,
}: {
  widget: DashboardWidgetShape;
  state: TableState;
}) => {
  if (state.status === "loading") {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (state.status === "error") {
    return <ErrorState title="Could not load data" detail={state.message} />;
  }

  const { columns, rows, totalRows } = state;

  // Section 22.7: an empty table gets an explicit empty state, never a chart
  // drawn from nothing.
  if (totalRows === 0) {
    return (
      <EmptyState
        message={`No rows in "${widget.sourceTable}". Nothing to display.`}
      />
    );
  }

  const knownFields = widget.fields.filter((field) =>
    columns.some((column) => column.name === field),
  );

  if (knownFields.length === 0) {
    return (
      <ErrorState
        title="Widget references no available column"
        detail={`Config asked for ${JSON.stringify(widget.fields)} in "${widget.sourceTable}", which reports columns ${JSON.stringify(columns.map((c) => c.name))}.`}
      />
    );
  }

  if (widget.type === "kpi_card") {
    const result = computeKpi(
      rows,
      knownFields,
      columns,
      widget.aggregation,
      (widget as any).filter,
      (widget as any).filters,
      widget.title,
    );

    if (result.kind === "not-numeric") {
      return (
        <ErrorState
          title={`"${result.field}" is not a numeric field`}
          detail={`Cannot compute ${widget.aggregation} on "${result.field}" in "${widget.sourceTable}": its inferred type is not numeric.`}
        />
      );
    }

    const { value, field, usedRows } = result;
    const filterNote = (widget as any).filter
      ? `${(widget as any).filter.column} ${(widget as any).filter.op ?? "eq"} "${(widget as any).filter.value}"`
      : usedRows < totalRows
        ? `${usedRows} of ${totalRows} rows`
        : `all ${totalRows} rows`;

    return (
      <div className="flex h-full flex-col justify-between p-1.5">
        <div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-bold tracking-wider text-[color:var(--color-steel)] uppercase truncate">
              {widget.title}
            </span>
            <span className="rounded-full bg-[color:var(--color-forest-surface)] px-2.5 py-0.5 text-[10px] font-bold text-[color:var(--color-forest-mid)] border border-[color:var(--color-forest-bright)]/20 shrink-0">
              {widget.sourceTable}
            </span>
          </div>

          <div className="mt-2.5 flex items-baseline gap-2">
            <p className="font-mono text-3xl md:text-4xl font-black tracking-tight text-[color:var(--color-forest)] tabular-nums">
              {formatNumber(value)}
            </p>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between border-t border-[color:var(--color-cloud)]/70 pt-2 text-[11px] text-[color:var(--color-steel)]">
          <span className="font-medium">
            {widget.aggregation !== "none" ? `${widget.aggregation} · ` : ""}
            {filterNote}
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-[color:var(--color-cloud-light)] px-2 py-0.5 text-[10px] font-bold text-[color:var(--color-forest-bright)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--color-forest-bright)]" />
            {usedRows === totalRows ? "100% data" : "Filtered"}
          </span>
        </div>
      </div>
    );
  }

  if (widget.type === "table") {
    return (
      <div className="h-full min-h-56 overflow-auto rounded-lg border border-[color:var(--color-cloud)]">
        <table className="w-full border-collapse text-left text-xs">
          <thead className="sticky top-0 bg-[color:var(--color-cloud-light)] border-b border-[color:var(--color-cloud)] shadow-2xs">
            <tr>
              {knownFields.map((field) => (
                <th
                  key={field}
                  scope="col"
                  className="whitespace-nowrap px-3 py-2 font-bold text-[color:var(--color-forest)]"
                >
                  {field}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-cloud)]/70 bg-white">
            {rows.map((row, index) => (
              <tr
                key={index}
                className="transition-colors hover:bg-[color:var(--color-forest-surface)]/60"
              >
                {knownFields.map((field) => (
                  <td
                    key={field}
                    className="max-w-72 truncate px-3 py-2 align-middle text-[color:var(--color-ink)] font-medium"
                    title={formatCell(row[field])}
                  >
                    {formatCell(row[field])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {totalRows > rows.length ? (
          <div className="p-2 bg-[color:var(--color-cloud-light)]/40 border-t border-[color:var(--color-cloud)] text-[11px] text-[color:var(--color-steel)] text-right">
            Showing {rows.length} of {totalRows} rows.
          </div>
        ) : null}
      </div>
    );
  }

  const { categoryField, measureFields } = resolveChartFields(
    knownFields,
    columns,
  );

  if (!categoryField) {
    return (
      <ErrorState
        title="No category column for this chart"
        detail={`Fields ${JSON.stringify(knownFields)} contain no groupable column, so a ${widget.type} chart would be misleading.`}
      />
    );
  }

  const series = buildCategorySeries(
    rows,
    categoryField,
    measureFields,
    widget.aggregation,
    columns,
    (widget as any).filter,
    (widget as any).filters,
    widget.title,
  );

  if (series.length === 0) {
    return <EmptyState message="No data points match this chart's fields." />;
  }

  const measures =
    measureFields.length > 0
      ? measureFields
      : ["count"];

  const seriesColours = resolveSeriesColours(widget);

  if (widget.type === "line") {
    return (
      <ChartFrame>
        <LineChart data={series} margin={{ top: 12, right: 16, bottom: 8, left: -6 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" opacity={0.7} />
          <XAxis dataKey="category" tick={axisStyle} tickLine={false} />
          <YAxis tick={axisStyle} tickLine={false} />
          <Tooltip formatter={tooltipFormatter} contentStyle={{ borderRadius: "8px", border: "1px solid #e2e8f0", boxShadow: "0 2px 4px rgba(0,0,0,0.06)", fontWeight: 600 }} />
          {measures.length > 1 ? <Legend wrapperStyle={{ fontSize: "11px", fontWeight: 600 }} /> : null}
          {measures.map((measure, index) => (
            <Line
              key={measure}
              type="monotone"
              dataKey={measure}
              stroke={seriesColours[index % seriesColours.length]}
              strokeWidth={2.5}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ChartFrame>
    );
  }

  if (widget.type === "pie") {
    const measure = measures[0] ?? "count";

    return (
      <ChartFrame>
        <PieChart margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
          <Tooltip formatter={tooltipFormatter} contentStyle={{ borderRadius: "8px", border: "1px solid #e2e8f0", fontWeight: 600 }} />
          <Legend wrapperStyle={{ fontSize: "11px", fontWeight: 600, paddingTop: "4px" }} />
          <Pie
            data={series}
            dataKey={measure}
            nameKey="category"
            cx="50%"
            cy="48%"
            outerRadius={95}
            innerRadius={50}
            paddingAngle={2.5}
            isAnimationActive={false}
          >
            {series.map((_entry, index) => (
              <Cell
                key={`cell-${index}`}
                fill={seriesColours[index % seriesColours.length]}
              />
            ))}
          </Pie>
        </PieChart>
      </ChartFrame>
    );
  }

  const isHorizontal =
    widget.type === "horizontal_bar" ||
    (widget as any).orientation === "horizontal" ||
    (widget as any).layout === "horizontal" ||
    (widget.type === "bar" && /\b(horizontal)\b/i.test(widget.title));

  if (isHorizontal) {
    return (
      <ChartFrame>
        <BarChart
          layout="vertical"
          data={series}
          margin={{ top: 12, right: 24, bottom: 8, left: 24 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" opacity={0.7} horizontal={false} vertical={true} />
          <XAxis type="number" tick={axisStyle} tickLine={false} />
          <YAxis
            type="category"
            dataKey="category"
            tick={axisStyle}
            tickLine={false}
            width={100}
          />
          <Tooltip
            formatter={tooltipFormatter}
            contentStyle={{
              borderRadius: "8px",
              border: "1px solid #e2e8f0",
              boxShadow: "0 2px 4px rgba(0,0,0,0.06)",
              fontWeight: 600,
            }}
          />
          {measures.length > 1 ? (
            <Legend wrapperStyle={{ fontSize: "11px", fontWeight: 600 }} />
          ) : null}
          {measures.map((measure, index) => (
            <Bar
              key={measure}
              dataKey={measure}
              maxBarSize={32}
              fill={seriesColours[index % seriesColours.length]}
              radius={[0, 5, 5, 0]}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ChartFrame>
    );
  }

  return (
    <ChartFrame>
      <BarChart data={series} margin={{ top: 12, right: 16, bottom: 8, left: -6 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" opacity={0.7} />
        <XAxis dataKey="category" tick={axisStyle} tickLine={false} />
        <YAxis tick={axisStyle} tickLine={false} />
        <Tooltip formatter={tooltipFormatter} contentStyle={{ borderRadius: "8px", border: "1px solid #e2e8f0", boxShadow: "0 2px 4px rgba(0,0,0,0.06)", fontWeight: 600 }} />
        {measures.length > 1 ? <Legend wrapperStyle={{ fontSize: "11px", fontWeight: 600 }} /> : null}
        {measures.map((measure, index) => (
          <Bar
            key={measure}
            dataKey={measure}
            maxBarSize={48}
            fill={seriesColours[index % seriesColours.length]}
            radius={[5, 5, 0, 0]}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ChartFrame>
  );
};

export const WidgetRenderer = ({
  widget,
  state,
}: {
  widget: DashboardWidgetShape;
  state: TableState;
}) => {
  const rowSpan = widget.type === "kpi_card" ? Math.min(widget.position.h, 2) : Math.min(Math.max(widget.position.h, 1), 4);
  const colSpan = Math.min(Math.max(widget.position.w, 1), 12);

  return (
    <Card
      style={{
        "--col-span": `span ${colSpan}`,
        "--row-span": `span ${rowSpan}`,
      } as React.CSSProperties}
      data-widget-id={widget.widgetId}
      data-widget-type={widget.type}
      className="col-span-1 md:[grid-column:var(--col-span)] md:[grid-row:var(--row-span)] group rounded-2xl border border-[color:var(--color-cloud)] bg-white shadow-2xs hover:border-[color:var(--color-forest-bright)]/30 hover:shadow-md transition-all duration-200 flex flex-col min-w-0 w-full overflow-hidden"
    >
      {widget.type !== "kpi_card" ? (
        <CardHeader className="py-2.5 px-4 bg-[color:var(--color-cloud-light)]/40 border-b border-[color:var(--color-cloud)]/80">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-xs font-extrabold text-[color:var(--color-forest)] tracking-tight truncate max-w-[70%]">
              {widget.title}
            </CardTitle>
            <span className="rounded-full bg-white/90 px-2 py-0.5 text-[9px] font-bold text-[color:var(--color-steel)] border border-[color:var(--color-cloud)] shadow-2xs shrink-0">
              {widget.sourceTable}
              {widget.aggregation !== "none" ? ` · ${widget.aggregation}` : ""}
            </span>
          </div>
        </CardHeader>
      ) : null}
      <CardBody className={widget.type === "table" ? "overflow-hidden p-0 flex-1" : widget.type === "kpi_card" ? "p-4 flex-1" : "p-3.5 flex-1"}>
        <div className={widget.type === "table" ? "h-full p-2" : "h-full"}>
          <WidgetBody widget={widget} state={state} />
        </div>
      </CardBody>
    </Card>
  );
};
