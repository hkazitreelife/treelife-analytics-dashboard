import { getPayload } from "payload";
import config from "./payload.config";
import { createClaudeConfigClient } from "../../worker/src/services/claudeConfig";
import { createClaudeDocumentSummaryClient } from "../../worker/src/services/claudeDocumentSummary";
import { buildDatasetMetadata } from "@analytics/shared";
import path from "path";

async function run() {
  console.log("Initializing Payload...");
  const payload = await getPayload({ config });
  
  // 1. Dashboard config
  console.log("Fetching datasets...");
  const datasets = await payload.find({ collection: "datasets", limit: 1 });
  if (datasets.docs.length > 0) {
    const dataset = datasets.docs[0];
    const data = dataset.data as any;
    const client = createClaudeConfigClient(process.env.ANTHROPIC_API_KEY!);
    const metadata = buildDatasetMetadata(
      dataset.id.toString(),
      dataset.name,
      data?.tables || [],
      data?.relationships || []
    );
    console.log("Generating config for:", dataset.name);
    const result = await client.generateConfig(metadata, data?.tables || []);
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
    const data = doc.data as any;
    console.log("Generating summary for:", doc.name);
    const result = await summaryClient.generateSummary(data?.fullText || "", data?.sections || []);
    console.log("Document Summary Output:", JSON.stringify(result.keyPoints.map((k: any) => ({
      statement: k.statement,
      presentation: k.presentation
    })), null, 2));
  }

  process.exit(0);
}

run().catch(console.error);

