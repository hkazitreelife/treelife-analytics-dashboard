import path from "path";
import dotenv from "dotenv";

// Must load environment variables before importing anything else
dotenv.config({ path: path.resolve(process.cwd(), "../apps/web/.env.local") });

import { getPayload } from "payload";
import { createClaudeConfigClient } from "./services/claudeConfig";
import { createClaudeDocumentSummaryClient } from "./services/claudeDocumentSummary";
import { buildDatasetMetadata } from "@analytics/shared";

async function run() {
  console.log("Initializing Payload...");
  const { default: config } = await import("../../apps/web/payload.config" as any);
  const payload = await getPayload({ config });
  
  // 1. Dashboard config
  console.log("Fetching datasets...");
  const datasets = await payload.find({ collection: "datasets", limit: 1 });
  const dataset = datasets.docs[0];
  if (dataset) {
    const client = createClaudeConfigClient(process.env.ANTHROPIC_API_KEY!);
    const tables = (dataset.data as any)?.tables || [];
    const relationships = (dataset.data as any)?.relationships || [];
    const metadata = buildDatasetMetadata(
      dataset.id.toString(),
      dataset.name,
      tables,
      relationships
    );
    console.log("Generating config for:", dataset.name);
    const result = await client.generateConfig(metadata, tables);
    console.log("Dashboard Insights Output:", JSON.stringify(result.insights.map(i => ({
      finding: i.finding,
      presentation: i.presentation
    })), null, 2));
  } else {
    console.log("No datasets found.");
  }
  
  // 2. Document Summary
  console.log("Fetching documents...");
  const docs = await payload.find({ collection: "documents", limit: 2 });
  const summaryClient = createClaudeDocumentSummaryClient(process.env.ANTHROPIC_API_KEY!);
  for (const doc of docs.docs) {
    console.log("Generating summary for:", doc.name);
    const result = await summaryClient.generateSummary(doc.fullText as string, doc.sections as any);
    console.log("Document Summary Output:", JSON.stringify(result.keyPoints.map(k => ({
      statement: k.statement,
      presentation: k.presentation
    })), null, 2));
  }

  process.exit(0);
}

run().catch(console.error);
