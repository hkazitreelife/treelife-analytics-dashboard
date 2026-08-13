"use client";

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

// References the same CSS variables globals.css defines from the brand theme
// (@theme block), rather than duplicating their hex values, so a future
// palette change there does not leave charts on stale colours.
const SERIES_COLOURS = [
  "var(--color-forest-mid)",
  "var(--color-cobalt)",
  "var(--color-gold)",
  "var(--color-terracotta)",
  "var(--color-grape)",
  "var(--color-forest-bright)",
  "var(--color-steel)",
];

const axisStyle = { fontSize: 11, fill: "var(--color-steel)" } as const;

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
  <div className="h-full min-h-56 w-full">
    <ResponsiveContainer width="100%" height="100%">
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
    const result = computeKpi(rows, knownFields, columns, widget.aggregation);

    // The config asked for sum/avg on a field that isn't numeric. Refuse to
    // show a number built by stripping letters out of an id or a category,
    // and say so visibly rather than rendering nothing.
    if (result.kind === "not-numeric") {
      return (
        <ErrorState
          title={`"${result.field}" is not a numeric field`}
          detail={`Cannot compute ${widget.aggregation} on "${result.field}" in "${widget.sourceTable}": its inferred type is not numeric.`}
        />
      );
    }

    const { value, field, usedRows } = result;

    return (
      <div className="flex h-full flex-col justify-center">
        <p className="text-3xl font-semibold tracking-tight text-[color:var(--color-forest)]">
          {formatNumber(value)}
        </p>
        <p className="mt-1 text-xs text-[color:var(--color-steel)]">
          {widget.aggregation === "count"
            ? `count of rows in ${widget.sourceTable}`
            : widget.aggregation === "distinct"
              ? `distinct values of ${field ?? "n/a"} in ${widget.sourceTable}`
              : `${widget.aggregation} of ${field ?? "n/a"} over ${usedRows} of ${totalRows} rows`}
        </p>
      </div>
    );
  }

  if (widget.type === "table") {
    return (
      <div className="h-full overflow-auto">
        <table className="w-full border-collapse text-left text-xs">
          <thead className="sticky top-0 bg-[color:var(--color-cloud)]">
            <tr>
              {knownFields.map((field) => (
                <th
                  key={field}
                  scope="col"
                  className="whitespace-nowrap px-2 py-1.5 font-semibold text-[color:var(--color-forest)]"
                >
                  {field}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                key={index}
                className="border-b border-[color:var(--color-cloud)] last:border-0"
              >
                {knownFields.map((field) => (
                  <td
                    key={field}
                    className="max-w-72 truncate px-2 py-1.5 align-top text-[color:var(--color-ink)]"
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
          <p className="mt-2 text-xs text-[color:var(--color-steel)]">
            Showing {rows.length} of {totalRows} rows.
          </p>
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
  );

  if (series.length === 0) {
    return (
      <EmptyState
        message={`No values in "${categoryField}" to group by. Nothing to chart.`}
      />
    );
  }

  const measures = measureFields.length > 0 ? measureFields : ["count"];

  if (widget.type === "pie") {
    const measure = measures[0]!;

    return (
      <ChartFrame>
        <PieChart>
          <Tooltip formatter={tooltipFormatter} />
          <Legend wrapperStyle={axisStyle} />
          <Pie
            data={series}
            dataKey={measure}
            nameKey="category"
            cx="50%"
            cy="45%"
            // Numeric radius and no animation: a percentage radius combined with
            // the entry animation left Recharts 3 rendering no sector paths.
            outerRadius={72}
            isAnimationActive={false}
          >
            {series.map((entry, index) => (
              <Cell
                key={entry.category}
                fill={SERIES_COLOURS[index % SERIES_COLOURS.length]}
              />
            ))}
          </Pie>
        </PieChart>
      </ChartFrame>
    );
  }

  if (widget.type === "line") {
    return (
      <ChartFrame>
        <LineChart data={series} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
          <CartesianGrid stroke="var(--color-cloud)" />
          <XAxis dataKey="category" tick={axisStyle} />
          <YAxis tick={axisStyle} />
          <Tooltip formatter={tooltipFormatter} />
          {measures.length > 1 ? <Legend wrapperStyle={axisStyle} /> : null}
          {measures.map((measure, index) => (
            <Line
              key={measure}
              type="monotone"
              dataKey={measure}
              stroke={SERIES_COLOURS[index % SERIES_COLOURS.length]}
              strokeWidth={2}
              dot={false}
            />
          ))}
        </LineChart>
      </ChartFrame>
    );
  }

  return (
    <ChartFrame>
      <BarChart data={series} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
        <CartesianGrid stroke="var(--color-cloud)" />
        <XAxis dataKey="category" tick={axisStyle} />
        <YAxis tick={axisStyle} />
        <Tooltip formatter={tooltipFormatter} />
        {measures.length > 1 ? <Legend wrapperStyle={axisStyle} /> : null}
        {measures.map((measure, index) => (
          <Bar
            key={measure}
            dataKey={measure}
            fill={SERIES_COLOURS[index % SERIES_COLOURS.length]}
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
}) => (
  <Card
    style={{
      gridColumn: `span ${Math.min(Math.max(widget.position.w, 1), 12)}`,
      gridRow: `span ${Math.max(widget.position.h, 1)}`,
    }}
    data-widget-id={widget.widgetId}
    data-widget-type={widget.type}
  >
    <CardHeader>
      <CardTitle>{widget.title}</CardTitle>
      <p className="mt-0.5 text-xs text-[color:var(--color-steel)]">
        {widget.sourceTable}
        {widget.aggregation !== "none" ? ` · ${widget.aggregation}` : ""}
      </p>
    </CardHeader>
    <CardBody className={widget.type === "table" ? "overflow-hidden p-0" : ""}>
      <div className={widget.type === "table" ? "h-full p-2" : "h-full"}>
        <WidgetBody widget={widget} state={state} />
      </div>
    </CardBody>
  </Card>
);
