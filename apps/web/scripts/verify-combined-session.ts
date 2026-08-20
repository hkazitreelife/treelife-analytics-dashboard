import path from "path";
import { fileURLToPath } from "url";
import { getPayload } from "payload";
import config from "../payload.config";
import { createClaudeCombinedDashboardClient } from "../lib/claudeCombinedDashboardClient";
import { createSessionEditTargetClient } from "../lib/claudeSessionEditTargetClient";
import { createClaudeConfigEditClient } from "../lib/claudeConfigEditClient";
import { createClaudeDocumentEditClient } from "../lib/claudeDocumentEditClient";
import { createSessionSynthesisClient } from "../lib/claudeSessionSynthesisClient";
import { runSessionSynthesis } from "../lib/sessionSynthesis";
import { runSessionEdit } from "../lib/sessionEdit";
import { publishDatasetEvent } from "../lib/events";

const main = async () => {
  console.log("Initializing Payload for combined session verification...");
  const payload = await getPayload({ config });
  const apiKey = process.env.ANTHROPIC_API_KEY!;

  const users = await payload.find({ collection: "users", limit: 1 });
  const adminUser = users.docs[0];
  const userId = adminUser ? Number(adminUser.id) : 1;

  // 1. Fetch real dataset and real document
  console.log("Fetching real dataset and document...");
  const datasets = await payload.find({
    collection: "datasets",
    where: { name: { contains: "Treelife" } },
    limit: 1,
  });

  const documents = await payload.find({
    collection: "documents",
    where: { name: { contains: "Treelife" } },
    limit: 1,
  });

  const dataset = datasets.docs[0];
  const document = documents.docs[0];

  if (!dataset || !document) {
    console.error("Missing required dataset or document. Datasets count:", datasets.totalDocs, "Documents count:", documents.totalDocs);
    process.exit(1);
  }

  console.log(`Found Dataset: "${dataset.name}" (ID: ${dataset.id})`);
  console.log(`Found Document: "${document.name}" (ID: ${document.id})`);

  // 2. Test Initial Upload / Creation flow
  console.log("\n--- Testing Initial Multi-Source Session Creation Pipeline ---");
  const session = await payload.create({
    collection: "sessions",
    data: {
      name: "Executive Overview",
      datasets: [dataset.id as any],
      documents: [document.id as any],
      status: "synthesizing",
    },
  });

  const synthesisClient = createSessionSynthesisClient(apiKey);
  const combinedDashboardClient = createClaudeCombinedDashboardClient(apiKey);

  const initialResult = await runSessionSynthesis(String(session.id), {
    payload,
    synthesisClient,
    combinedDashboardClient,
    adminIntent: "Executive Overview combining attrition numbers with leadership takeaways",
  });

  console.log("Initial Session Creation Synthesis OK:", initialResult.ok);
  if (initialResult.ok && initialResult.config) {
    console.log("Combined Dashboard Title:", initialResult.config.title);
    console.log("Combined Dashboard Tabs Count:", initialResult.config.tabs.length);
    console.log("Combined Insights Count:", initialResult.config.insights.length);
    console.log("Insights Sample:", JSON.stringify(initialResult.config.insights.map(i => ({
      finding: i.finding,
      presentation: i.presentation,
    })), null, 2));
  }

  // 3. Test Edit Flow (Target Resolver & Combined Reshaping)
  console.log("\n--- Testing Edit Target Resolution & Reshaping Pipeline ---");
  const targetClient = createSessionEditTargetClient(apiKey);
  const editClient = createClaudeConfigEditClient(apiKey);
  const documentEditClient = createClaudeDocumentEditClient(apiKey);

  const editPrompt = "Executive Overview should be a combined dashboard of Copy of Copy of Treelife Attrition Report FY2526 and Treelife_Attrition_Hiring_Insights with stop start continue categories";
  console.log("Sending Edit Prompt:", editPrompt);

  const editResult = await runSessionEdit(String(session.id), editPrompt, {
    payload,
    editClient,
    documentEditClient,
    combinedDashboardClient,
    targetClient,
    publishEvent: publishDatasetEvent,
    userId,
  });

  console.log("\nEdit Result:", JSON.stringify(editResult, null, 2));

  // 4. Fetch updated session and report final output
  const updatedSession = await payload.findByID({
    collection: "sessions",
    id: session.id,
    depth: 0,
  });

  const finalOverview = updatedSession.overview as any;
  console.log("\n================ FINAL VERIFIED OUTPUT ================");
  console.log("Session Name:", updatedSession.name);
  console.log("Session Status:", updatedSession.status);
  console.log("Combined Config Title:", finalOverview?.config?.title);
  console.log("Tabs:", finalOverview?.config?.tabs?.map((t: any) => t.tabName));
  console.log("Insights count:", finalOverview?.config?.insights?.length);
  console.log("\nCategorized Insights with 15.1 Presentation Shapes:");
  console.log(JSON.stringify(finalOverview?.config?.insights?.map((i: any) => ({
    finding: i.finding,
    metrics: i.metrics,
    whyItMatters: i.whyItMatters,
    recommendedAction: i.recommendedAction,
    presentation: i.presentation,
  })), null, 2));

  process.exit(0);
};

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
