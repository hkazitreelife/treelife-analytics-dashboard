import * as XLSX from "xlsx";
import Anthropic from "@anthropic-ai/sdk";
import type { Payload } from "payload";

export interface ParsedTable {
  name: string;
  columns: string[];
  rowCount: number;
  sampleRows: any[];
  allRows: any[];
}

export function parseWorkbookBuffer(buffer: Buffer): ParsedTable[] {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const tables: ParsedTable[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    const rawRows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: null });
    if (rawRows.length === 0) continue;

    const columns = Object.keys(rawRows[0] || {});
    if (columns.length === 0) continue;

    tables.push({
      name: sheetName,
      columns,
      rowCount: rawRows.length,
      sampleRows: rawRows.slice(0, 10),
      allRows: rawRows,
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

    // 3. Extract AI dashboard layout using Anthropic / OpenRouter
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const baseURL = process.env.ANTHROPIC_BASE_URL;
    const model = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest";

    let dashboardConfig: any = null;

    if (apiKey) {
      try {
        const client = new Anthropic({
          apiKey,
          ...(baseURL ? { baseURL } : {}),
        });

        const tableSummary = tables.map((t) => ({
          sheet: t.name,
          columns: t.columns,
          rowCount: t.rowCount,
          sampleRows: t.sampleRows.slice(0, 3),
        }));

        const prompt = [
          "You are an executive business intelligence analytics architect.",
          "Design a rich dashboard configuration in JSON for the uploaded dataset.",
          `Filename: ${filename}`,
          `Tables & Columns: ${JSON.stringify(tableSummary, null, 2)}`,
          intentPrompt ? `User Strategic Intent: "${intentPrompt}"` : "",
          "",
          "Return ONLY valid JSON matching this schema:",
          "{",
          '  "title": "Executive Dashboard Title",',
          '  "description": "Executive summary of findings",',
          '  "tabs": [',
          "    {",
          '      "tabId": "overview",',
          '      "tabName": "Executive Overview",',
          '      "widgets": [',
          "        {",
          '          "widgetId": "w1",',
          '          "type": "kpi_card",',
          '          "title": "Total Records",',
          `          "sourceTable": "${tables[0]?.name || "Sheet1"}",`,
          `          "fields": ["${tables[0]?.columns[0] || "id"}"],`,
          '          "aggregation": "count",',
          '          "position": { "col": 0, "row": 0, "w": 4, "h": 2 }',
          "        },",
          "        {",
          '          "widgetId": "w2",',
          '          "type": "bar_chart",',
          '          "title": "Distribution",',
          `          "sourceTable": "${tables[0]?.name || "Sheet1"}",`,
          `          "fields": ["${tables[0]?.columns[0] || "category"}", "${tables[0]?.columns[1] || "value"}"],`,
          '          "aggregation": "sum",',
          '          "position": { "col": 4, "row": 0, "w": 8, "h": 4 }',
          "        }",
          "      ]",
          "    }",
          "  ],",
          '  "insights": [',
          "    {",
          '      "insightId": "ins1",',
          `      "finding": "Dataset contains ${totalRows} records across ${tables.length} table(s).",`,
          '      "whyItMatters": "Core business baseline established.",',
          '      "severity": "positive"',
          "    }",
          "  ]",
          "}",
        ].join("\n");

        const msg = await client.messages.create({
          model,
          max_tokens: 4000,
          messages: [{ role: "user", content: prompt }],
        });

        const text = msg.content[0]?.type === "text" ? msg.content[0].text : "";
        const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, text];
        const clean = jsonMatch[1]?.trim() || text.trim();
        dashboardConfig = JSON.parse(clean);
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
            name: t.name,
            columns: t.columns,
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
