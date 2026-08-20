import { getPayload } from "payload";
import config from "./apps/web/payload.config";
import { createClaudeConfigClient } from "./worker/src/services/claudeConfig";
import { createClaudeDocumentSummaryClient } from "./worker/src/services/claudeDocumentSummary";
import { buildDatasetMetadata } from "./packages/shared/src";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), "apps/web/.env.local") });

async function run() {
  console.log("Initializing Payload...");
  const payload = await getPayload({ config });
  
  // 1. Dashboard config
  console.log("Fetching datasets...");
  const datasets = await payload.find({ collection: "datasets", limit: 1 });
  if (datasets.docs.length > 0) {
    const dataset = datasets.docs[0];
    const client = createClaudeConfigClient(process.env.ANTHROPIC_API_KEY!);
    const metadata = buildDatasetMetadata(
      dataset.id.toString(),
      dataset.name,
      dataset.tables as any,
      (dataset.relationships || []) as any
    );
    console.log("Generating config for:", dataset.name);
    const result = await client.generateConfig(metadata, dataset.tables as any);
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
