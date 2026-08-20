import { GoogleGenAI } from "@google/genai";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

// Zod validation schemas for AI outputs
export const DatasetMetadataSchema = z.object({
  summary: z.string(),
  businessDomain: z.string().optional(),
  detectedRole: z.enum(["primary_data", "reference_lookup", "summary_aggregate"]).optional(),
  suggestedKPIs: z.array(z.string()).default([]),
  keyEntities: z.array(z.string()).default([]),
});

export type ExtractedDatasetMetadata = z.infer<typeof DatasetMetadataSchema>;

export const GeneratedDashboardLayoutSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  tabs: z.array(
    z.object({
      tabId: z.string(),
      tabName: z.string(),
      widgets: z.array(
        z.object({
          widgetId: z.string(),
          type: z.enum(["kpi_card", "bar_chart", "horizontal_bar", "line_chart", "pie_chart", "table"]),
          title: z.string(),
          sourceTable: z.string(),
          fields: z.array(z.string()),
          aggregation: z.enum(["none", "sum", "count", "avg", "distinct"]).default("none"),
          orientation: z.enum(["horizontal", "vertical"]).optional(),
          color: z.string().optional(),
          position: z.object({
            col: z.number(),
            row: z.number(),
            w: z.number(),
            h: z.number(),
          }),
        }),
      ),
    }),
  ),
  insights: z.array(
    z.object({
      insightId: z.string(),
      finding: z.string(),
      whyItMatters: z.string(),
      recommendedAction: z.string().optional(),
      severity: z.enum(["positive", "negative", "warning", "info"]).default("info"),
      metrics: z.array(
        z.object({
          label: z.string(),
          sourceTable: z.string().optional(),
          sourceField: z.string().optional(),
          aggregation: z.string().optional(),
          kind: z.string().optional(),
        }),
      ).default([]),
      relatedTables: z.array(z.string()).default([]),
    }),
  ).default([]),
});

export type GeneratedDashboardLayout = z.infer<typeof GeneratedDashboardLayoutSchema>;

/**
 * Extracts structured dataset metadata and semantic domain classification using Gemini 2.5 Flash.
 */
export const extractMetadataWithGemini = async (
  tableSchemas: Array<{ name: string; columns: string[]; sampleRows?: any[] }>,
): Promise<ExtractedDatasetMetadata> => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  const ai = new GoogleGenAI({ apiKey });

  const prompt = [
    "Analyze the following dataset structure and extract high-level business intelligence metadata:",
    JSON.stringify(tableSchemas, null, 2),
    "",
    "Return a valid JSON object matching this schema exactly:",
    `{
      "summary": "Concise 1-2 sentence executive overview of what this dataset represents",
      "businessDomain": "e.g. HR / Finance / Sales / Operations / Logistics",
      "detectedRole": "primary_data",
      "suggestedKPIs": ["Key Metric 1", "Key Metric 2"],
      "keyEntities": ["Entity Category 1", "Entity Category 2"]
    }`,
    "Return only the raw JSON object with no markdown formatting.",
  ].join("\n");

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      temperature: 0.1,
    },
  });

  const text = response.text || "{}";
  const parsed = JSON.parse(text);
  return DatasetMetadataSchema.parse(parsed);
};

/**
 * Generates an executive dashboard configuration using Claude 3.5 Sonnet.
 */
export const generateDashboardWithClaude = async (
  metadata: ExtractedDatasetMetadata,
  tableSchemas: Array<{ name: string; columns: string[]; rowCount?: number }>,
  intentPrompt?: string,
): Promise<GeneratedDashboardLayout> => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured.");
  }

  const anthropic = new Anthropic({ apiKey });
  const modelName = process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest";

  const systemInstruction = [
    "You are an expert executive business intelligence dashboard architect.",
    "Design a structured executive dashboard configuration using ONLY the provided tables and columns.",
    "Rules:",
    "1. Never invent table names or column names; use the verbatim names provided.",
    "2. For long category labels, use orientation:'horizontal' or type:'horizontal_bar'.",
    "3. Support KPI cards with aggregations (sum, count, avg, distinct).",
    "4. Return only a valid JSON matching the required schema.",
  ].join("\n");

  const userPrompt = [
    `Dataset Summary: ${metadata.summary}`,
    `Business Domain: ${metadata.businessDomain || "General"}`,
    `Tables & Columns: ${JSON.stringify(tableSchemas, null, 2)}`,
    intentPrompt ? `User Intent / Focus Request: "${intentPrompt}"` : "",
    "",
    "Generate the full dashboard layout with tabs, KPI cards, charts, and actionable executive insights.",
  ].join("\n");

  const message = await anthropic.messages.create({
    model: modelName,
    max_tokens: 4000,
    system: systemInstruction,
    messages: [
      {
        role: "user",
        content: userPrompt,
      },
    ],
  });

  const contentBlock = message.content[0];
  const responseText = contentBlock?.type === "text" ? contentBlock.text : "";

  // Extract JSON from possible markdown wrapping
  const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, responseText];
  const cleanJson = jsonMatch[1]?.trim() || responseText.trim();

  const parsed = JSON.parse(cleanJson);
  return GeneratedDashboardLayoutSchema.parse(parsed);
};
