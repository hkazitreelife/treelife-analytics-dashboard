import * as XLSX from "xlsx";
import type { Payload } from "payload";
import Anthropic from "@anthropic-ai/sdk";
import {
  buildDatasetMetadata,
  dashboardConfigToolSchema,
  normalizeDashboardConfigInput,
  resolveClaudeModel,
  type NormalizedTableShape,
} from "@analytics/shared";

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
      // 1. Primary path: Official Claude tool calling via @anthropic-ai/sdk (identical to worker)
      try {
        const client = new Anthropic({
          apiKey,
          baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
        });

        const normalizedTables: NormalizedTableShape[] = tables.map((t) => ({
          tableName: t.name,
          tableRole: "data" as const,
          headerRowIndex: 0,
          columns: t.columnsWithTypes.map((c) => ({
            name: c.name,
            inferredType: c.inferredType,
            nullable: true,
            sampleValues: (t.sampleRows || []).slice(0, 5).map((r) => String(r[c.name] ?? "")),
          })),
          rows: t.allRows || t.sampleRows || [],
          rowHash: `hash_${t.name}`,
        }));

        const metadata = buildDatasetMetadata(
          String(datasetId),
          filename,
          normalizedTables,
          [],
        );

        const modelName = resolveClaudeModel(
          process.env.ANTHROPIC_CONFIG_MODEL || "claude-sonnet-5",
        );

        const response = await client.messages.create({
          model: modelName,
          max_tokens: 16000,
          system: [
            "You are a Principal Executive Business Intelligence & Analytics Architect.",
            "Design a comprehensive multi-tab executive dashboard configuration and strategic insights for this dataset.",
            "STRICT RULES:",
            "1. ZERO RAW TABLES: Never emit 'table' widget type. Dashboards must be 100% VISUAL: use 'kpi_card', 'bar', 'horizontal_bar', 'line', 'pie'.",
            "2. MULTI-TAB ARCHITECTURE: If the dataset has multiple distinct domain sheets (e.g. Reconciliation Summary, Missing in 2B, In 2B Not in Books, Matched, Credit & Debit Notes), generate a dedicated tab for each domain in addition to an Executive Overview tab.",
            "3. ACTIONABLE INSIGHTS WITH LIVE METRICS & CHECKLISTS: Produce 4 to 6 quantified insights citing real metrics, business implications, recommended action steps, and assigned owners with presentation shape: 'tracker-item'.",
            "4. You must call the emit_dashboard_config tool exactly once.",
          ].join("\n"),
          tools: [
            {
              name: "emit_dashboard_config",
              description: "Emit the dashboard configuration and insights for this dataset.",
              input_schema: dashboardConfigToolSchema,
            },
          ],
          tool_choice: { type: "tool", name: "emit_dashboard_config" },
          messages: [
            {
              role: "user",
              content: [
                intentPrompt ? `User Strategic Intent: "${intentPrompt}"` : "",
                `Dataset Metadata:\n${JSON.stringify(metadata, null, 2)}`,
              ]
                .filter(Boolean)
                .join("\n\n"),
            },
          ],
        });

        const toolUse = response.content.find(
          (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
        );

        if (toolUse && toolUse.input) {
          const normalized = normalizeDashboardConfigInput(toolUse.input);
          dashboardConfig = normalized;
          console.log("[DirectIngestion] Dashboard generated successfully via Anthropic tool calling");
        }
      } catch (anthropicErr) {
        console.warn("[DirectIngestion] Anthropic SDK call failed, attempting fallback:", anthropicErr);
      }

      // 2. Secondary path: Multi-model OpenRouter completions
      if (!dashboardConfig || !Array.isArray(dashboardConfig.tabs) || dashboardConfig.tabs.length === 0) {
        try {
          const tableSummary = tables.map((t) => ({
            sheet: t.name,
            columns: t.columnsWithTypes.map((c) => `${c.name} (${c.inferredType})`),
            rowCount: t.rowCount,
            sampleRows: t.sampleRows.slice(0, 2),
          }));

          const prompt = [
            "You are a Principal Executive Business Intelligence & Analytics Architect.",
            "Transform this raw dataset into an elite, C-suite executive intelligence dashboard.",
            `Filename: ${filename}`,
            `Total Clean Records: ${totalRows}`,
            `Clean Structured Tables & Columns: ${JSON.stringify(tableSummary, null, 2)}`,
            intentPrompt ? `User Strategic Intent: "${intentPrompt}"` : "",
            "",
            "CRITICAL DESIGN ARCHITECTURE:",
            "1. ZERO RAW TABLES: Never emit 'table' widget type. Dashboards must be 100% VISUAL: use 'kpi_card', 'bar', 'horizontal_bar', 'line', 'pie'.",
            "2. MULTI-TAB EXECUTIVE STRUCTURE: Organize multi-table data into distinct tabs for every sheet domain.",
            "3. SMART MEASURE MAPPING: Map categorical/date columns to category axis, and numeric columns to measures.",
            "4. ACTIONABLE INSIGHTS WITH LIVE NUMBERS & CHECKLIST TRACKER: Provide 4-6 high-impact executive insights with specific numbers and action items.",
            "",
            "Return ONLY valid JSON matching schema with { title, description, tabs, insights }.",
          ].join("\n");

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 35000);

          const modelsToTry = [
            "anthropic/claude-sonnet-5",
            "google/gemini-2.5-flash",
            "openai/gpt-4o",
          ];

          for (const modelId of modelsToTry) {
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
                  max_tokens: 4000,
                }),
                signal: controller.signal,
              });

              if (openRouterRes.ok) {
                const aiData = await openRouterRes.json();
                const rawText = aiData.choices?.[0]?.message?.content || "";
                const jsonMatch =
                  rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, rawText];
                const clean = jsonMatch[1]?.trim() || rawText.trim();
                const parsed = JSON.parse(clean);
                if (parsed && Array.isArray(parsed.tabs) && parsed.tabs.length > 0) {
                  dashboardConfig = normalizeDashboardConfigInput(parsed);
                  console.log(`[DirectIngestion] Dashboard generated successfully using ${modelId}`);
                  break;
                }
              }
            } catch (modelErr) {
              console.warn(`[DirectIngestion] Model ${modelId} failed:`, modelErr);
            }
          }

          clearTimeout(timeout);
        } catch (aiErr: unknown) {
          console.warn("[DirectIngestion] OpenRouter fallback error:", aiErr);
        }
      }
    }

    // Intelligent Multi-Sheet Synthesis if AI was unavailable
    if (!dashboardConfig || !Array.isArray(dashboardConfig.tabs) || dashboardConfig.tabs.length === 0) {
      console.log("[DirectIngestion] Building multi-sheet synthesized executive dashboard");

      const generatedTabs: any[] = [];
      const generatedInsights: any[] = [];

      // 1. Executive Overview Tab
      const overviewWidgets: any[] = [];
      tables.slice(0, 4).forEach((table, idx) => {
        const numCol = table.columnsWithTypes.find((c) => c.inferredType === "numeric")?.name;
        const catCol = table.columnsWithTypes.find(
          (c) => c.inferredType === "categorical" || c.inferredType === "text" || c.inferredType === "id",
        )?.name || table.columns[0];

        overviewWidgets.push({
          widgetId: `ov_kpi_${idx + 1}`,
          type: "kpi_card",
          title: numCol ? `Total ${numCol} (${table.name})` : `${table.name} Count`,
          sourceTable: table.name,
          fields: [numCol || catCol || "id"],
          aggregation: numCol ? "sum" : "count",
          position: { col: idx * 3, row: 0, w: 3, h: 2 },
        });
      });

      if (tables[0]) {
        const t0 = tables[0];
        const catCol = t0.columnsWithTypes.find((c) => c.inferredType === "categorical")?.name || t0.columns[0];
        const numCol = t0.columnsWithTypes.find((c) => c.inferredType === "numeric")?.name;

        overviewWidgets.push({
          widgetId: "ov_chart_1",
          type: "bar",
          title: `${t0.name} Breakdown by ${catCol || "Category"}`,
          sourceTable: t0.name,
          fields: numCol && catCol ? [catCol, numCol] : [catCol || "Category"],
          aggregation: numCol ? "sum" : "count",
          position: { col: 0, row: 2, w: 6, h: 4 },
        });
      }

      if (tables[1] || tables[0]) {
        const t1 = tables[1] || tables[0];
        const dateCol = t1.columnsWithTypes.find((c) => c.inferredType === "date")?.name;
        const catCol = t1.columnsWithTypes.find((c) => c.inferredType === "categorical")?.name || t1.columns[1] || t1.columns[0];
        const numCol = t1.columnsWithTypes.find((c) => c.inferredType === "numeric")?.name;

        overviewWidgets.push({
          widgetId: "ov_chart_2",
          type: dateCol ? "line" : "horizontal_bar",
          title: `${t1.name} ${dateCol ? "Trend" : "Distribution"}`,
          sourceTable: t1.name,
          fields: dateCol && numCol ? [dateCol, numCol] : catCol && numCol ? [catCol, numCol] : [catCol || "Category"],
          aggregation: numCol ? "sum" : "count",
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
        const numCols = table.columnsWithTypes.filter((c) => c.inferredType === "numeric");
        const catCols = table.columnsWithTypes.filter(
          (c) => c.inferredType === "categorical" || c.inferredType === "text" || c.inferredType === "id",
        );
        const dateCols = table.columnsWithTypes.filter((c) => c.inferredType === "date");

        // KPI 1: Record Count
        widgets.push({
          widgetId: `t_${tIdx + 1}_kpi_1`,
          type: "kpi_card",
          title: `${table.name} Volume`,
          sourceTable: table.name,
          fields: [table.columns[0] || "id"],
          aggregation: "count",
          position: { col: 0, row: 0, w: 4, h: 2 },
        });

        // KPI 2: Sum / Avg Metric
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

        // KPI 3: Avg Metric or Distinct
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

        // Chart 1: Categorical Bar / Distribution
        const xCol = catCols[0]?.name || table.columns[0];
        const yCol = numCols[0]?.name;
        widgets.push({
          widgetId: `t_${tIdx + 1}_chart_1`,
          type: "bar",
          title: `${table.name} by ${xCol || "Category"}`,
          sourceTable: table.name,
          fields: yCol && xCol ? [xCol, yCol] : [xCol || "Category"],
          aggregation: yCol ? "sum" : "count",
          position: { col: 0, row: 2, w: 6, h: 4 },
        });

        // Chart 2: Trend Line or Horizontal Bar
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

        // Generate dynamic insight for this sheet
        generatedInsights.push({
          insightId: `ins_${tIdx + 1}`,
          finding: `${table.name} captures ${table.rowCount} records with ${numCols.length} key metric measures.`,
          whyItMatters: `Provides granular operational visibility into ${table.name.toLowerCase()} trends and performance.`,
          recommendedAction: `Review ${table.name.toLowerCase()} variance during executive operations review.`,
          severity: tIdx % 2 === 0 ? "positive" : "warning",
          presentation: {
            shape: "tracker-item",
            status: tIdx === 0 ? "Tracked" : "Action Required",
            owner: "Operations Lead",
          },
          relatedTables: [table.name],
          metrics: [
            { label: `${table.name} Rows`, value: String(table.rowCount) },
            ...(numCols[0] ? [{ label: `Measure: ${numCols[0].name}`, value: "Active" }] : []),
          ],
        });
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
