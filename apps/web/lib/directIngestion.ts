import * as XLSX from "xlsx";
import type { Payload } from "payload";

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
  values: unknown[],
): "numeric" | "date" | "boolean" | "id" | "categorical" | "text" {
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

    // Detect header row index (row with the most non-empty string headers in the first 6 rows)
    let headerRowIdx = 0;
    let maxCols = 0;
    for (let r = 0; r < Math.min(6, aoa.length); r++) {
      const row = aoa[r];
      if (!Array.isArray(row)) continue;
      const validHeaders = row.filter(
        (c) => typeof c === "string" && c.trim().length > 0 && !c.trim().startsWith("__EMPTY"),
      );
      if (validHeaders.length > maxCols) {
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

    const rows: Record<string, any>[] = [];
    for (let r = headerRowIdx + 1; r < aoa.length; r++) {
      const row = aoa[r];
      if (!Array.isArray(row)) continue;
      const isBlank = row.every(
        (cell) => cell === null || cell === undefined || String(cell).trim() === "",
      );
      if (isBlank) continue;

      const rowObj: Record<string, any> = {};
      let hasData = false;
      for (let c = 0; c < headers.length; c++) {
        const h = headers[c]!;
        const cell = row[c];
        rowObj[h] = cell !== undefined && cell !== "" ? cell : null;
        if (rowObj[h] !== null) hasData = true;
      }
      if (hasData) {
        rows.push(rowObj);
      }
    }

    if (rows.length === 0) continue;

    const columnsWithTypes: ParsedColumn[] = headers.map((colName) => {
      const sampleVals = rows.slice(0, 100).map((r) => r[colName]);
      const inferredType = inferColumnType(sampleVals);
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

export async function processIngestionDirectly(
  payload: Payload,
  jobId: string | number,
  datasetId: string | number,
  buffer: Buffer,
  filename: string,
  intentPrompt?: string | null,
): Promise<void> {
  try {
    // 1. Update job to processing
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

    // 3. Extract AI dashboard layout using OpenRouter / Claude
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
          "You are an executive business intelligence analytics architect.",
          "Design a rich, multi-tab executive dashboard configuration in JSON for this uploaded dataset.",
          `Filename: ${filename}`,
          `Clean Tables & Typed Columns: ${JSON.stringify(tableSummary, null, 2)}`,
          intentPrompt ? `User Strategic Intent: "${intentPrompt}"` : "",
          "",
          "CRITICAL RULES:",
          "1. Use ONLY the exact column names listed above for each table. Never invent column names.",
          "2. For numeric KPIs (avg, sum), select numeric columns.",
          "3. For charts, select categorical/date columns for X-axis and numeric columns for measures.",
          "4. For multi-table datasets, organize widgets across logical tabs (e.g. Overview, Detailed Breakdown, Trends).",
          "",
          "Return ONLY valid JSON matching this schema:",
          "{",
          '  "title": "Executive Dashboard Title",',
          '  "description": "Comprehensive executive summary",',
          '  "tabs": [',
          "    {",
          '      "tabId": "overview",',
          '      "tabName": "Executive Overview",',
          '      "widgets": [',
          "        {",
          '          "widgetId": "w1",',
          '          "type": "kpi_card",',
          '          "title": "Total Volume",',
          `          "sourceTable": "${tables[0]?.name || "Data"}",`,
          `          "fields": ["${tables[0]?.columns[0] || "id"}"],`,
          '          "aggregation": "count",',
          '          "position": { "col": 0, "row": 0, "w": 4, "h": 2 }',
          "        }",
          "      ]",
          "    }",
          "  ],",
          '  "insights": [',
          "    {",
          '      "insightId": "ins1",',
          `      "finding": "Dataset contains ${totalRows} records across ${tables.length} table(s).",`,
          '      "whyItMatters": "Core business baseline established.",',
          '      "severity": "positive",',
          '      "relatedTables": [],',
          '      "metrics": []',
          "    }",
          "  ]",
          "}",
        ].join("\n");

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 25000);

        const openRouterRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "anthropic/claude-sonnet-5",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 3500,
          }),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (openRouterRes.ok) {
          const aiData = await openRouterRes.json();
          const rawText = aiData.choices?.[0]?.message?.content || "";
          const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, rawText];
          const clean = jsonMatch[1]?.trim() || rawText.trim();
          dashboardConfig = JSON.parse(clean);
        }
      } catch (aiErr: unknown) {
        console.warn("[DirectIngestion] AI generation fallback:", aiErr);
      }
    }

    // Default structured layout if AI is unavailable or fails
    if (!dashboardConfig || !dashboardConfig.tabs) {
      const firstTable = tables[0];
      const col1 = firstTable?.columns[0] || "Category";
      const col2 = firstTable?.columns[1] || "Value";

      dashboardConfig = {
        title: `${filename.replace(/\.[^/.]+$/, "")} Analytics`,
        description: `Automated executive analytics for ${totalRows} records.`,
        tabs: [
          {
            tabId: "overview",
            tabName: "Executive Overview",
            widgets: [
              {
                widgetId: "kpi_total",
                type: "kpi_card",
                title: "Total Volume",
                sourceTable: firstTable?.name || "Data",
                fields: [col1],
                aggregation: "count",
                position: { col: 0, row: 0, w: 4, h: 2 },
              },
              {
                widgetId: "chart_overview",
                type: "bar_chart",
                title: `${col1} Distribution`,
                sourceTable: firstTable?.name || "Data",
                fields: [col1, col2],
                aggregation: "count",
                position: { col: 4, row: 0, w: 8, h: 4 },
              },
            ],
          },
        ],
        insights: [
          {
            insightId: "ins_1",
            finding: `Successfully ingested ${totalRows} rows across ${tables.length} table(s).`,
            whyItMatters: "Dataset is verified and ready for deep executive analytics.",
            severity: "positive",
          },
        ],
      };
    }

    if (Array.isArray(dashboardConfig.insights)) {
      dashboardConfig.insights = dashboardConfig.insights.map((ins: any) => ({
        ...ins,
        metrics: Array.isArray(ins.metrics) ? ins.metrics : [],
        relatedTables: Array.isArray(ins.relatedTables) ? ins.relatedTables : [],
      }));
    }

    // 4. Save Config
    await payload.create({
      collection: "configs",
      data: {
        dataset: Number(datasetId),
        version: 1,
        config: dashboardConfig,
        insights: dashboardConfig.insights || [],
        generatedBy: "initial_auto_generation",
      },
    });

    // 5. Update Dataset record
    await payload.update({
      collection: "datasets",
      id: Number(datasetId),
      data: {
        status: "ready",
        totalRows,
        tableNames: tables.map((t) => ({ tableName: t.name })),
        data: {
          tables: tables.map((t) => ({
            tableName: t.name,
            tableRole: "dimension",
            columns: t.columnsWithTypes,
            rows: t.allRows,
          })),
        } as any,
      },
    });

    // 6. Ensure single-source session exists
    const existingSessions = await payload.find({
      collection: "sessions",
      where: {
        datasets: {
          contains: Number(datasetId),
        },
      },
      limit: 1,
    });

    if (existingSessions.docs.length === 0) {
      await payload.create({
        collection: "sessions",
        data: {
          name: filename.replace(/\.[^/.]+$/, ""),
          datasets: [Number(datasetId)],
          status: "ready",
          overview: {
            findings: dashboardConfig.insights || [],
          },
        },
      });
    }

    // 7. Update Job record to completed
    await payload.update({
      collection: "jobs",
      id: Number(jobId),
      data: {
        status: "completed",
      },
    });

    console.log(`[DirectIngestion] ✅ Ingestion complete for Job ${jobId}, Dataset ${datasetId}`);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[DirectIngestion] ❌ Failed job ${jobId}:`, errorMsg);
    await payload.update({
      collection: "jobs",
      id: Number(jobId),
      data: {
        status: "failed",
        error: errorMsg,
      },
    });
  }
}
