import * as XLSX from "xlsx";
import { createHash } from "crypto";
import type { Payload } from "payload";
import {
  normalizeDashboardConfigInput,
} from "@analytics/shared";
import { ensureSingleSourceSession } from "./sessionWrapper";

export interface ParsedColumn {
  name: string;
  inferredType: "numeric" | "date" | "boolean" | "id" | "categorical" | "text";
}

export interface ParsedTable {
  name: string;
  columns: string[];
  columnsWithTypes: ParsedColumn[];
  rowCount: number;
  sampleRows: any[];
  allRows: any[];
}

export function inferColumnType(
  name: string,
  values: unknown[],
): "numeric" | "date" | "boolean" | "id" | "categorical" | "text" {
  const lowerName = String(name || "").toLowerCase().trim();

  // Strict semantic identification for ID columns
  if (
    /^(sr\.?\s*no|s\.?\s*no|serial|id|emp_?id|employee_?id|code|#|index|no|serial_?number)$/i.test(lowerName) ||
    lowerName.endsWith("_id") ||
    lowerName.endsWith(" id")
  ) {
    return "id";
  }

  // Strict semantic identification for Date and Time columns
  if (
    /(date|joining|exit|dob|month|year|timestamp|day|time|lwd|last_working_day)/i.test(lowerName)
  ) {
    return "date";
  }

  // Strict semantic identification for Hierarchy/Category numbers (Level 1..6, Grade 1..5)
  if (
    /^(level|grade|tier|band|step|stage|rank|quarter|status|priority)$/i.test(lowerName) ||
    lowerName.endsWith("_level") ||
    lowerName.endsWith(" level")
  ) {
    return "categorical";
  }

  const nonNull = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== "");
  if (nonNull.length === 0) return "text";

  let numericCount = 0;
  let dateCount = 0;
  let boolCount = 0;

  for (const val of nonNull) {
    if (
      typeof val === "boolean" ||
      val === "true" ||
      val === "false" ||
      val === "TRUE" ||
      val === "FALSE"
    ) {
      boolCount++;
      continue;
    }
    if (typeof val === "number" && !isNaN(val)) {
      numericCount++;
      continue;
    }
    if (typeof val === "string") {
      const clean = val.replace(/[$€£¥₹\s,%]/g, "").replace(/\((.*)\)/, "-$1");
      const parsed = Number.parseFloat(clean);
      if (!isNaN(parsed) && Number.isFinite(parsed)) {
        numericCount++;
        continue;
      }
      if (
        !/^\d+$/.test(val) &&
        !isNaN(Date.parse(val)) &&
        val.length > 5 &&
        (val.includes("-") || val.includes("/"))
      ) {
        dateCount++;
        continue;
      }
    }
  }

  const threshold = nonNull.length * 0.5;
  if (numericCount >= threshold) return "numeric";
  if (boolCount >= threshold) return "boolean";
  if (dateCount >= threshold) return "date";

  const unique = new Set(nonNull.map((v) => String(v).trim()));
  if (unique.size <= 25 || unique.size < nonNull.length * 0.4) {
    return "categorical";
  }

  return "text";
}

export function parseWorkbookBuffer(buffer: Buffer): ParsedTable[] {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const tables: ParsedTable[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    const aoa = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, defval: "" });
    if (aoa.length === 0) continue;

    // Scan top 10 rows to locate the true multi-column header row
    let headerRowIdx = 0;
    let maxCols = 0;
    for (let r = 0; r < Math.min(10, aoa.length); r++) {
      const row = aoa[r];
      if (!Array.isArray(row)) continue;
      const validHeaders = row.filter(
        (c) => typeof c === "string" && c.trim().length > 0 && !c.trim().startsWith("__EMPTY"),
      );
      if (validHeaders.length > maxCols && validHeaders.length >= 2) {
        maxCols = validHeaders.length;
        headerRowIdx = r;
      }
    }

    const headerRow = aoa[headerRowIdx] || [];
    const headers: string[] = [];
    for (let c = 0; c < headerRow.length; c++) {
      const val = String(headerRow[c] || "").trim();
      const colName = val.length > 0 ? val : `Column_${c + 1}`;
      let uniqueName = colName;
      let counter = 1;
      while (headers.includes(uniqueName)) {
        uniqueName = `${colName}_${counter++}`;
      }
      headers.push(uniqueName);
    }

    if (headers.length === 0) continue;

    const rows: Record<string, unknown>[] = [];
    for (let r = headerRowIdx + 1; r < aoa.length; r++) {
      const row = aoa[r];
      if (!Array.isArray(row)) continue;
      const isBlank = row.every(
        (cell) => cell === null || cell === undefined || String(cell).trim() === "",
      );
      if (isBlank) continue;

      const rowObj: Record<string, unknown> = {};
      let hasData = false;
      for (let c = 0; c < headers.length; c++) {
        const h = headers[c];
        const cell = row[c];
        rowObj[h] = cell !== undefined && cell !== "" ? cell : null;
        if (rowObj[h] !== null) hasData = true;
      }
      if (hasData) rows.push(rowObj);
    }

    if (rows.length === 0) continue;

    const columnsWithTypes = headers.map((colName) => {
      const sampleVals = rows.slice(0, 100).map((r) => r[colName]);
      const inferredType = inferColumnType(colName, sampleVals);
      return { name: colName, inferredType };
    });

    tables.push({
      name: sheetName,
      columns: headers,
      columnsWithTypes,
      rowCount: rows.length,
      sampleRows: rows.slice(0, 10),
      allRows: rows,
    });
  }

  return tables;
}

/**
 * Rejects an AI-generated dashboard config that references a table/column
 * absent from the parsed sheets, or sums/averages a non-numeric column.
 * This path (the OpenRouter branch below) has no Zod validation of its own,
 * unlike worker/src/services/claudeConfig.ts's findUnknownReferences /
 * findUnresolvableMetrics for the sanctioned Gemini+Claude pipeline -- so a
 * hallucinated field, or a wrong aggregation (e.g. summing a "Level" or
 * "Date of joining" column because nothing stopped it), would otherwise be
 * stored exactly as returned. This is the minimum equivalent check for this
 * path: any problem found rejects the whole attempt so it falls through to
 * the next model or the deterministic per-sheet synthesis below, rather
 * than storing a partially valid config (CLAUDE.md: "never store partially
 * valid output").
 */
function findAiConfigProblems(config: any, tables: ParsedTable[]): string[] {
  const problems: string[] = [];
  const tableByName = new Map(tables.map((t) => [t.name, t]));

  for (const tab of config.tabs ?? []) {
    for (const widget of tab.widgets ?? []) {
      const table = tableByName.get(widget.sourceTable);

      if (!table) {
        problems.push(
          `widget "${widget.widgetId}" references unknown table "${widget.sourceTable}"`,
        );
        continue;
      }

      const columnType = new Map(
        table.columnsWithTypes.map((c) => [c.name, c.inferredType]),
      );
      const fields: string[] = Array.isArray(widget.fields) ? widget.fields : [];

      for (const field of fields) {
        if (!columnType.has(field)) {
          problems.push(
            `widget "${widget.widgetId}" references unknown column "${field}" in table "${widget.sourceTable}"`,
          );
        }
      }

      if (widget.aggregation === "sum" || widget.aggregation === "avg") {
        const numericFields = fields.filter((f) => columnType.get(f) === "numeric");

        if (numericFields.length === 0) {
          problems.push(
            `widget "${widget.widgetId}" uses aggregation "${widget.aggregation}" but none of its fields (${fields.join(", ")}) in table "${widget.sourceTable}" are numeric`,
          );
        }
      }
    }
  }

  for (const insight of config.insights ?? []) {
    for (const tableName of insight.relatedTables ?? []) {
      if (!tableByName.has(tableName)) {
        problems.push(
          `insight "${insight.insightId}" references unknown table "${tableName}"`,
        );
      }
    }
  }

  // Sheet-tab purity: every tab except the one designated cross-sheet
  // overview must source every widget from a single table. Without this, a
  // model free to invent "domain" tabs (e.g. "Reason & Tenure Dynamics")
  // can blend fields from different sheets into one tab, which is what
  // looks like sheets being combined/mixed to an admin even when each
  // individual field reference is technically valid.
  const isOverviewTab = (tab: any): boolean =>
    tab.tabId === "executive_overview" || /overview/i.test(String(tab.tabName ?? ""));

  const tabsSeenPerTable = new Set<string>();

  for (const tab of config.tabs ?? []) {
    if (isOverviewTab(tab)) {
      continue;
    }

    const sourceTables = new Set(
      (tab.widgets ?? []).map((widget: any) => widget.sourceTable).filter(Boolean),
    );

    if (sourceTables.size > 1) {
      problems.push(
        `tab "${tab.tabName}" mixes widgets from multiple sheets (${Array.from(sourceTables).join(", ")}) -- every non-overview tab must stay scoped to one sheet`,
      );
    }

    for (const t of sourceTables) {
      tabsSeenPerTable.add(t as string);
    }
  }

  // Coverage: every parsed sheet must get its own tab somewhere, not just a
  // mention inside the combined overview -- CLAUDE.md's "never silently
  // drop a table" rule, applied to tabs the same way it applies to rows.
  for (const table of tables) {
    if (!tabsSeenPerTable.has(table.name)) {
      problems.push(
        `sheet "${table.name}" has no dedicated tab of its own (only appears, if at all, in the combined overview)`,
      );
    }
  }

  return problems;
}

/**
 * Builds the Section 14 normalized-dataset shape (tableName, tableRole,
 * columns with nullable/sampleValues, rows, rowHash) from what
 * parseWorkbookBuffer already extracted, so it can be written to the
 * Dataset's own `data` field.
 *
 * This was the other half of the gap that caused "Could not load data" on
 * every widget and "No session wraps this dataset yet" on every dataset
 * ingested through this in-process path: processIngestionDirectly wrote a
 * dashboard config referencing table/column names, but never wrote the
 * actual rows those widgets need at render time. /api/datasets/:id/data and
 * apps/web/lib/chat.ts both read dataset.data.tables directly -- with it
 * never populated, every chart/KPI that fetches rows to aggregate had
 * nothing to compute from, while insight numbers baked directly into the
 * config's insights array (not fetched live) kept showing correctly, which
 * is why only some parts of a dashboard failed rather than all of it.
 */
function buildNormalizedTables(tables: ParsedTable[]) {
  return tables.map((table) => ({
    tableName: table.name,
    tableRole: "data" as const,
    // Not tracked as a distinct field on ParsedTable -- parseWorkbookBuffer
    // already sliced rows to start after the detected header row, so by the
    // time a table reaches here its own row 0 is a real data row.
    headerRowIndex: 0,
    columns: table.columnsWithTypes.map((column) => {
      const values = table.allRows.map((row) => row[column.name]);
      const nonNull = values.filter(
        (value) => value !== null && value !== undefined && String(value).trim() !== "",
      );

      return {
        name: column.name,
        inferredType: column.inferredType,
        nullable: nonNull.length < values.length,
        sampleValues: nonNull.slice(0, 5).map((value) => String(value)),
      };
    }),
    rows: table.allRows,
    rowHash: createHash("sha256").update(JSON.stringify(table.allRows)).digest("hex"),
  }));
}

const toNumericValue = (value: unknown): number | null => {
  if (typeof value === "number" && !Number.isNaN(value)) {
    return value;
  }
  if (typeof value === "string") {
    const clean = value.replace(/[$€£¥₹\s,%]/g, "").replace(/\((.*)\)/, "-$1");
    const parsed = Number.parseFloat(clean);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/**
 * Every table's fallback insight was previously the exact same three
 * sentences with only the table name substituted ("X captures N records
 * across key operational segments... Provides granular visibility into x
 * trends..."), which reads identically on every tab and says nothing
 * dataset-specific -- exactly the "no intelligence layer" complaint. This
 * computes an actual finding from that table's own real column values
 * (dominant category and its share, numeric totals) instead, so two
 * different sheets produce two genuinely different findings. Still a
 * template sentence structure, but every number and name in it is read
 * from this table's real rows, never invented or shared across tables.
 */
function buildTableInsight(table: ParsedTable, insightId: string) {
  const numCols = table.columnsWithTypes.filter((c) => c.inferredType === "numeric");
  const catCols = table.columnsWithTypes.filter(
    (c) => c.inferredType === "categorical" || c.inferredType === "text",
  );

  const metrics: { label: string; value: string }[] = [
    { label: `${table.name} Records`, value: String(table.rowCount) },
  ];

  let dominantShare = 0;
  const findingParts: string[] = [`${table.name} holds ${table.rowCount} record${table.rowCount === 1 ? "" : "s"}.`];

  if (catCols[0]) {
    const counts = new Map<string, number>();
    for (const row of table.allRows) {
      const raw = row[catCols[0].name];
      if (raw === null || raw === undefined || String(raw).trim() === "") continue;
      const key = String(raw).trim();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    let top: [string, number] | null = null;
    for (const entry of counts) {
      if (!top || entry[1] > top[1]) top = entry;
    }

    if (top) {
      const [topValue, topCount] = top;
      dominantShare = topCount / table.rowCount;
      const pct = Math.round(dominantShare * 100);
      findingParts.push(
        `By ${catCols[0].name}, "${topValue}" leads with ${topCount} of ${table.rowCount} records (${pct}%), across ${counts.size} distinct value${counts.size === 1 ? "" : "s"} in that column.`,
      );
      metrics.push({ label: `Top ${catCols[0].name}`, value: `${topValue} (${pct}%)` });
    }
  }

  if (numCols[0]) {
    const values = table.allRows.map((row) => toNumericValue(row[numCols[0].name])).filter((v): v is number => v !== null);

    if (values.length > 0) {
      const sum = values.reduce((total, value) => total + value, 0);
      const avg = sum / values.length;
      findingParts.push(
        `${numCols[0].name} totals ${sum.toLocaleString("en-IN", { maximumFractionDigits: 2 })} across those records, averaging ${avg.toLocaleString("en-IN", { maximumFractionDigits: 2 })} per record.`,
      );
      metrics.push({ label: `${numCols[0].name} Total`, value: sum.toLocaleString("en-IN", { maximumFractionDigits: 2 }) });
    }
  }

  // Signal, not index parity: a category concentrated above 60% in one
  // value is worth flagging as a concentration risk; otherwise this table
  // reads as routine and gets marked informational.
  const isConcentrated = dominantShare >= 0.6 && catCols.length > 0;

  return {
    insightId,
    finding: findingParts.join(" "),
    whyItMatters: isConcentrated
      ? `A single ${catCols[0]!.name} value accounts for the majority of ${table.name}'s records, which concentrates risk or dependency in one segment rather than spreading it across the table.`
      : `${table.name}'s records are spread across its tracked ${catCols[0]?.name ?? "fields"} without one dominant concentration, which is the pattern to watch for if that changes going forward.`,
    recommendedAction: isConcentrated
      ? `Review why ${table.name} is concentrated in this one ${catCols[0]!.name} value and whether that dependency is acceptable.`
      : `Monitor ${table.name} for a shift toward concentration in future periods.`,
    severity: isConcentrated ? "warning" : "info",
    presentation: {
      shape: "tracker-item",
      status: isConcentrated ? "Action Required" : "Tracked",
      owner: "Operations Lead",
    },
    relatedTables: [table.name],
    metrics,
  };
}

export async function processIngestionDirectly(
  payload: Payload,
  jobId: number | string,
  datasetId: number | string,
  buffer: Buffer,
  filename: string,
  intentPrompt?: string | null,
): Promise<void> {
  console.log(`[DirectIngestion] Starting ingestion for dataset ${datasetId} (${filename})...`);

  try {
    // 1. Mark Job Processing
    await payload.update({
      collection: "jobs",
      id: Number(jobId),
      data: { status: "processing" },
    });

    // 2. Parse workbook
    const tables = parseWorkbookBuffer(buffer);
    if (tables.length === 0) {
      throw new Error(`The uploaded file "${filename}" contains no valid sheets or tabular data.`);
    }

    const totalRows = tables.reduce((acc, t) => acc + t.rowCount, 0);

    // 3. Extract AI dashboard layout using OpenRouter directly
    const apiKey = process.env.ANTHROPIC_API_KEY;

    let dashboardConfig: any = null;

    if (apiKey) {
      try {
        const tableSummary = tables.map((t) => ({
          sheet: t.name,
          columns: t.columnsWithTypes.map((c) => `${c.name} (${c.inferredType})`),
          rowCount: t.rowCount,
          sampleRows: t.sampleRows.slice(0, 2),
        }));

        const prompt = [
          "You are a Principal Executive Business Intelligence & Analytics Architect.",
          "Transform this dataset into a world-class, C-suite executive dashboard with multiple tabs and actionable insights.",
          `Filename: ${filename}`,
          `Total Clean Records: ${totalRows}`,
          `Structured Sheets & Column Types: ${JSON.stringify(tableSummary, null, 2)}`,
          intentPrompt ? `User Strategic Intent: "${intentPrompt}"` : "",
          "",
          "EXECUTIVE DESIGN RULES:",
          "1. ZERO RAW TABLES: Never emit 'table' widget type. Dashboards must be 100% VISUAL: use 'kpi_card', 'bar', 'horizontal_bar', 'line', 'pie'.",
          "2. NO ID OR DATE SUMS: Never sum or average ID columns (Sr No, Emp ID, Index, Serial) or date columns (Date of Joining, LWD).",
          [
            "3. ONE TAB PER SHEET, NEVER MIXED: Every sheet listed above (",
            tables.map((t) => t.name).join(", "),
            ") gets exactly one dedicated tab, tabName matching that sheet's name verbatim.",
            " Every widget inside a sheet's tab must set sourceTable to that same sheet and use only",
            " that sheet's own columns -- never blend fields from a different sheet into a",
            " sheet-specific tab, even if two sheets seem related. In addition to those per-sheet tabs,",
            " add exactly one more tab named Executive Overview (tabId executive_overview) that may pull",
            " KPIs from multiple sheets for a cross-sheet summary -- that tab is the only place widgets",
            " from different sourceTables may appear together. This mirrors how a later multi-source",
            " session (datasets plus uploaded documents) stays separated per source with one combined",
            " view on top; the same rule applies within a single workbook's sheets now.",
          ].join(""),
          "4. QUANTIFIED INSIGHTS: Provide 4-6 high-impact executive insights citing real numbers, implications, recommended actions, and department owners with presentation shape: 'tracker-item'.",
          "",
          "Return ONLY valid JSON matching this schema:",
          "{",
          '  "title": "Executive Intelligence Dashboard Title",',
          '  "description": "High-level strategic briefing on metrics and performance",',
          '  "tabs": [',
          "    {",
          '      "tabId": "executive_overview",',
          '      "tabName": "Executive Overview",',
          '      "widgets": [',
          "        {",
          '          "widgetId": "w1",',
          '          "type": "kpi_card",',
          '          "title": "Total Volume",',
          `          "sourceTable": "${tables[0]?.name || "Data"}",`,
          `          "fields": ["${tables[0]?.columns[0] || "id"}"],`,
          '          "aggregation": "count",',
          '          "position": { "col": 0, "row": 0, "w": 3, "h": 2 }',
          "        }",
          "      ]",
          "    }",
          "  ],",
          '  "insights": [',
          "    {",
          '      "insightId": "ins1",',
          '      "finding": "Analytical finding with specific figures.",',
          '      "whyItMatters": "Strategic business implication.",',
          '      "recommendedAction": "Concrete executive next step.",',
          '      "severity": "positive",',
          '      "presentation": { "shape": "tracker-item", "status": "Action Required", "owner": "Leadership" },',
          '      "relatedTables": [],',
          '      "metrics": []',
          "    }",
          "  ]",
          "}",
        ].join("\n");

        const modelsToTry = [
          "anthropic/claude-sonnet-5",
          "google/gemini-2.5-flash",
          "openai/gpt-4o",
        ];

        for (const modelId of modelsToTry) {
          // A fresh controller per attempt -- these were previously shared
          // across the whole loop, so once the first model's timeout fired
          // and aborted it, every later model in this same loop was already
          // dead on arrival (the same AbortSignal stays aborted forever),
          // silently forcing every upload straight to the generic fallback
          // regardless of which model might otherwise have succeeded.
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 45000);

          try {
            const openRouterRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: modelId,
                messages: [{ role: "user", content: prompt }],
                // Was 4000 -- too small once the prompt started requiring a
                // dedicated tab per sheet (see "ONE TAB PER SHEET" rule
                // above): a 5+ sheet workbook's full tabs+widgets+insights
                // JSON regularly exceeds 4000 tokens, gets cut off
                // mid-object, fails JSON.parse, and silently falls through
                // to the generic per-table template below -- which is
                // exactly the "every tab's insight looks the same, no real
                // intelligence" symptom this was causing.
                max_tokens: 8000,
              }),
              signal: controller.signal,
            });

            if (openRouterRes.ok) {
              const aiData = await openRouterRes.json();
              const rawText = aiData.choices?.[0]?.message?.content || "";
              let clean = rawText.trim();
              if (clean.includes("```")) {
                const match = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
                if (match && match[1]) {
                  clean = match[1].trim();
                } else {
                  clean = clean.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
                }
              }
              const firstBrace = clean.indexOf("{");
              const lastBrace = clean.lastIndexOf("}");
              if (firstBrace !== -1 && lastBrace !== -1) {
                clean = clean.slice(firstBrace, lastBrace + 1);
              }
              const parsed = JSON.parse(clean);
              if (parsed && Array.isArray(parsed.tabs) && parsed.tabs.length > 0) {
                const candidate = normalizeDashboardConfigInput(parsed);
                const problems = findAiConfigProblems(candidate, tables);

                if (problems.length > 0) {
                  console.warn(
                    `[DirectIngestion] Model ${modelId} produced an invalid config, rejecting: ${problems.join("; ")}`,
                  );
                  continue;
                }

                dashboardConfig = candidate;
                console.log(`[DirectIngestion] Dashboard generated dynamically via AI using ${modelId}`);
                break;
              }
            }
          } catch (modelErr) {
            console.warn(`[DirectIngestion] Model ${modelId} failed:`, modelErr);
          } finally {
            clearTimeout(timeout);
          }
        }
      } catch (aiErr: unknown) {
        console.warn("[DirectIngestion] AI generation error:", aiErr);
      }
    }

    // Intelligent Multi-Sheet Synthesis if AI was unavailable
    if (!dashboardConfig || !Array.isArray(dashboardConfig.tabs) || dashboardConfig.tabs.length === 0) {
      console.log("[DirectIngestion] Building multi-sheet synthesized executive dashboard");

      const generatedTabs: any[] = [];
      const generatedInsights: any[] = [];

      const realNumCols = (t: ParsedTable) =>
        t.columnsWithTypes.filter((c) => c.inferredType === "numeric");
      const realCatCols = (t: ParsedTable) =>
        t.columnsWithTypes.filter(
          (c) => c.inferredType === "categorical" || c.inferredType === "text",
        );

      // 1. Executive Overview Tab
      const overviewWidgets: any[] = [];

      overviewWidgets.push({
        widgetId: "ov_kpi_1",
        type: "kpi_card",
        title: "Total Volume",
        sourceTable: tables[0]?.name || "Data",
        fields: [tables[0]?.columns[0] || "id"],
        aggregation: "count",
        position: { col: 0, row: 0, w: 3, h: 2 },
      });

      tables.slice(0, 3).forEach((table, idx) => {
        const nums = realNumCols(table);
        if (nums[0]) {
          overviewWidgets.push({
            widgetId: `ov_kpi_${idx + 2}`,
            type: "kpi_card",
            title: `Total ${nums[0].name}`,
            sourceTable: table.name,
            fields: [nums[0].name],
            aggregation: "sum",
            position: { col: (idx + 1) * 3, row: 0, w: 3, h: 2 },
          });
        } else {
          const cats = realCatCols(table);
          if (cats[0]) {
            overviewWidgets.push({
              widgetId: `ov_kpi_${idx + 2}`,
              type: "kpi_card",
              title: `Distinct ${cats[0].name}`,
              sourceTable: table.name,
              fields: [cats[0].name],
              aggregation: "distinct",
              position: { col: (idx + 1) * 3, row: 0, w: 3, h: 2 },
            });
          }
        }
      });

      if (tables[0]) {
        const t0 = tables[0];
        const cats = realCatCols(t0);
        const nums = realNumCols(t0);
        const catCol = cats[0]?.name || t0.columns[1] || t0.columns[0];
        const numCol = nums[0]?.name;

        overviewWidgets.push({
          widgetId: "ov_chart_1",
          type: "bar",
          title: `${t0.name} by ${catCol}`,
          sourceTable: t0.name,
          fields: numCol ? [catCol, numCol] : [catCol],
          aggregation: numCol ? "sum" : "count",
          position: { col: 0, row: 2, w: 6, h: 4 },
        });
      }

      const t1 = tables[1] || tables[0];
      if (t1) {
        const cats = realCatCols(t1);
        const nums = realNumCols(t1);
        const catCol = cats[0]?.name || t1.columns[0];
        const numCol = nums[0]?.name;

        overviewWidgets.push({
          widgetId: "ov_chart_2",
          type: "pie",
          title: `${t1.name} Distribution`,
          sourceTable: t1.name,
          fields: [catCol],
          aggregation: "count",
          position: { col: 6, row: 2, w: 6, h: 4 },
        });
      }

      generatedTabs.push({
        tabId: "executive_overview",
        tabName: "Executive Overview",
        widgets: overviewWidgets,
      });

      // 2. Specialized Tab for each Sheet
      tables.forEach((table, tIdx) => {
        const widgets: any[] = [];
        const numCols = realNumCols(table);
        const catCols = realCatCols(table);
        const dateCols = table.columnsWithTypes.filter((c) => c.inferredType === "date");

        widgets.push({
          widgetId: `t_${tIdx + 1}_kpi_1`,
          type: "kpi_card",
          title: `${table.name} Records`,
          sourceTable: table.name,
          fields: [table.columns[0] || "id"],
          aggregation: "count",
          position: { col: 0, row: 0, w: 4, h: 2 },
        });

        if (numCols[0]) {
          widgets.push({
            widgetId: `t_${tIdx + 1}_kpi_2`,
            type: "kpi_card",
            title: `Total ${numCols[0].name}`,
            sourceTable: table.name,
            fields: [numCols[0].name],
            aggregation: "sum",
            position: { col: 4, row: 0, w: 4, h: 2 },
          });
        }

        if (numCols[1] || numCols[0]) {
          const colToUse = numCols[1] || numCols[0];
          widgets.push({
            widgetId: `t_${tIdx + 1}_kpi_3`,
            type: "kpi_card",
            title: `Average ${colToUse.name}`,
            sourceTable: table.name,
            fields: [colToUse.name],
            aggregation: "avg",
            position: { col: 8, row: 0, w: 4, h: 2 },
          });
        } else if (catCols[0]) {
          widgets.push({
            widgetId: `t_${tIdx + 1}_kpi_3`,
            type: "kpi_card",
            title: `Distinct ${catCols[0].name}`,
            sourceTable: table.name,
            fields: [catCols[0].name],
            aggregation: "distinct",
            position: { col: 8, row: 0, w: 4, h: 2 },
          });
        }

        const xCol = catCols[0]?.name || table.columns[0];
        const yCol = numCols[0]?.name;
        widgets.push({
          widgetId: `t_${tIdx + 1}_chart_1`,
          type: "bar",
          title: `${table.name} Breakdown by ${xCol}`,
          sourceTable: table.name,
          fields: yCol && xCol ? [xCol, yCol] : [xCol || "Category"],
          aggregation: yCol ? "sum" : "count",
          position: { col: 0, row: 2, w: 6, h: 4 },
        });

        if (dateCols[0] && numCols[0]) {
          widgets.push({
            widgetId: `t_${tIdx + 1}_chart_2`,
            type: "line",
            title: `${numCols[0].name} Trend over ${dateCols[0].name}`,
            sourceTable: table.name,
            fields: [dateCols[0].name, numCols[0].name],
            aggregation: "sum",
            position: { col: 6, row: 2, w: 6, h: 4 },
          });
        } else if (catCols[1] || numCols[1]) {
          const secondX = catCols[1]?.name || catCols[0]?.name || table.columns[1] || table.columns[0];
          const secondY = numCols[1]?.name || numCols[0]?.name;
          widgets.push({
            widgetId: `t_${tIdx + 1}_chart_2`,
            type: "horizontal_bar",
            title: `${table.name} Analysis (${secondX})`,
            sourceTable: table.name,
            fields: secondY && secondX ? [secondX, secondY] : [secondX || "Category"],
            aggregation: secondY ? "avg" : "count",
            position: { col: 6, row: 2, w: 6, h: 4 },
          });
        } else {
          widgets.push({
            widgetId: `t_${tIdx + 1}_chart_2`,
            type: "pie",
            title: `${table.name} Share Distribution`,
            sourceTable: table.name,
            fields: [xCol || "Category"],
            aggregation: "count",
            position: { col: 6, row: 2, w: 6, h: 4 },
          });
        }

        generatedTabs.push({
          tabId: `tab_${tIdx + 1}`,
          tabName: table.name,
          widgets,
        });

        generatedInsights.push(buildTableInsight(table, `ins_${tIdx + 1}`));
      });

      dashboardConfig = {
        title: `${filename.replace(/\.[^/.]+$/, "").replace(/[_-]/g, " ")} Executive Dashboard`,
        description: `Executive intelligence synthesized across ${totalRows} records in ${tables.length} functional areas.`,
        tabs: generatedTabs,
        insights: generatedInsights,
      };
    }

    if (Array.isArray(dashboardConfig.insights)) {
      dashboardConfig.insights = dashboardConfig.insights.map((ins: any) => ({
        ...ins,
        metrics: Array.isArray(ins.metrics) ? ins.metrics : [],
        relatedTables: Array.isArray(ins.relatedTables) ? ins.relatedTables : [],
      }));
    }

    // 4. Save Config -- version was previously hardcoded to 1 always, which
    // is correct for a dataset's first-ever ingestion but creates a second,
    // ambiguous "version 1" row on any re-ingestion (a corrected re-upload,
    // or the reprocess endpoint added to repair datasets ingested before
    // this file wrote dataset.data). Mirrors worker/src/processors/
    // ingestion.ts's own fix for the same bug: query the current max
    // version for this dataset and write one past it.
    const existingConfigs = await payload.find({
      collection: "configs",
      where: { dataset: { equals: Number(datasetId) } },
      sort: "-version",
      limit: 1,
      depth: 0,
    });
    const nextVersion = (existingConfigs.docs[0]?.version ?? 0) + 1;

    await payload.create({
      collection: "configs",
      data: {
        dataset: Number(datasetId),
        version: nextVersion,
        config: dashboardConfig,
        insights: dashboardConfig.insights || [],
        generatedBy: "initial_auto_generation",
      },
    });

    // 5. Update Dataset record -- writes the actual normalized tables/rows
    // (see buildNormalizedTables's doc comment for why this was missing and
    // what broke without it), the real cross-sheet row total (totalRows had
    // been left at its creation-time default of 0 forever), and the sheet
    // names table (tableNames), all previously never written by this path.
    const normalizedTables = buildNormalizedTables(tables);
    const updatedDataset = await payload.update({
      collection: "datasets",
      id: Number(datasetId),
      data: {
        status: "ready",
        totalRows,
        tableNames: tables.map((t) => ({ tableName: t.name })),
        data: { tables: normalizedTables, relationships: [] },
      } as any,
    });

    // 5b. Wrap this dataset in its own single-source session, exactly like
    // worker/src/processors/ingestion.ts does for the BullMQ path -- without
    // this, /datasets/:id's "find the wrapping session" lookup 404s with
    // "No session wraps this dataset yet" for every dataset ingested
    // through this in-process path, which is what was happening in
    // production before this call existed here. Uses the dataset's own
    // stored name (not a re-derivation from filename) so it matches
    // exactly what the dataset record and its UI already show.
    await ensureSingleSourceSession(
      payload,
      "dataset",
      datasetId,
      (updatedDataset as any).name || filename.replace(/\.[^/.]+$/, ""),
    );

    // 6. Mark Job Completed
    await payload.update({
      collection: "jobs",
      id: Number(jobId),
      data: { status: "completed" },
    });

    console.log(`[DirectIngestion] Ingestion completed successfully for dataset ${datasetId}.`);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[DirectIngestion] Ingestion failed for dataset ${datasetId}:`, err);

    await payload.update({
      collection: "jobs",
      id: Number(jobId),
      data: {
        status: "failed",
        error: errorMsg,
      },
    });

    await payload.update({
      collection: "datasets",
      id: Number(datasetId),
      data: {
        status: "failed",
      } as any,
    });

    throw err;
  }
}
