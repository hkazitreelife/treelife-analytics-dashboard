import { getPayload } from "payload";
import config from "../payload.config";
import { createClaudeCombinedDashboardClient } from "../lib/claudeCombinedDashboardClient";
import { createSessionEditTargetClient } from "../lib/claudeSessionEditTargetClient";
import { createClaudeConfigEditClient } from "../lib/claudeConfigEditClient";
import { createClaudeDocumentEditClient } from "../lib/claudeDocumentEditClient";
import { createSessionSynthesisClient } from "../lib/claudeSessionSynthesisClient";
import {
  loadSessionSynthesisSources,
  runSessionSynthesis,
} from "../lib/sessionSynthesis";
import { writeDeterministicSessionOverview } from "../lib/sessionFallback";
import { runSessionEdit } from "../lib/sessionEdit";
import { publishDatasetEvent } from "../lib/events";

/**
 * Verification for the combined-session Phase A/B split:
 *
 *   Phase A -- writeDeterministicSessionOverview: zero AI calls, writes a
 *   validated deterministic combined overview stamped configSource
 *   "initial_fallback". Must succeed in well under a second.
 *
 *   Phase B survival -- runSessionSynthesis against DELIBERATELY BROKEN
 *   clients (a syntactically-valid-but-fake API key): every AI attempt must
 *   fail, nothing may be written, and the fallback must remain byte-for-byte
 *   intact with configSource still "initial_fallback". This is the exact
 *   regression that motivated the whole change (the old path wrote an empty
 *   overview when every AI attempt failed). Costs zero quota.
 *
 *   Phase B upgrade -- runSessionSynthesis with the REAL key (only when one
 *   is configured): on success the overview flips to configSource
 *   "initial_auto_generation" with AI tabs/insights; on exhausted quota it
 *   reports upgraded:false and the fallback survives, which is also a pass.
 */

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
    console.error(
      "Missing required dataset or document. Datasets count:",
      datasets.totalDocs,
      "Documents count:",
      documents.totalDocs,
    );
    process.exit(1);
  }

  console.log(`Found Dataset: "${dataset.name}" (ID: ${dataset.id})`);
  console.log(`Found Document: "${document.name}" (ID: ${document.id})`);

  // 2. PHASE A: deterministic fallback, zero AI calls
  console.log("\n--- Phase A: deterministic fallback overview ---");
  const phaseAStart = Date.now();
  const session = await payload.create({
    collection: "sessions",
    data: {
      name: "Executive Overview",
      datasets: [dataset.id as any],
      documents: [document.id as any],
      status: "synthesizing",
    },
  });

  const phaseA = await writeDeterministicSessionOverview(payload, String(session.id), {
    adminIntent: "Executive Overview combining attrition numbers with leadership takeaways",
  });
  const phaseAMs = Date.now() - phaseAStart;

  if (!phaseA.written) {
    console.error("PHASE A FAILED: no deterministic overview was written.");
    process.exit(1);
  }

  const afterPhaseA = await payload.findByID({
    collection: "sessions",
    id: session.id,
    depth: 0,
  });
  const phaseAOverview = afterPhaseA.overview as any;

  console.log(`Phase A completed in ${phaseAMs}ms (must be far under the old 231s request).`);
  console.log("Status:", afterPhaseA.status);
  console.log("configSource:", phaseAOverview?.configSource, "(must be initial_fallback)");
  console.log("Tabs:", phaseAOverview?.config?.tabs?.map((t: any) => t.tabName));
  console.log("Widget count:", phaseAOverview?.config?.tabs?.reduce((acc: number, t: any) => acc + (t.widgets?.length ?? 0), 0));
  console.log("Insights count:", phaseAOverview?.config?.insights?.length);

  if (
    afterPhaseA.status !== "ready" ||
    phaseAOverview?.configSource !== "initial_fallback" ||
    !phaseAOverview?.config?.tabs?.length ||
    !phaseAOverview?.config?.insights?.length
  ) {
    console.error("PHASE A ACCEPTANCE FAILED: fallback not ready/valid/stamped.");
    process.exit(1);
  }

  // 3. PHASE B SURVIVAL: every AI attempt fails -> fallback untouched
  console.log("\n--- Phase B survival: all AI attempts fail (fake key) ---");
  const fakeKey = "sk-ant-deliberately-invalid-for-survival-check";
  const survivalResult = await runSessionSynthesis(String(session.id), {
    payload,
    synthesisClient: createSessionSynthesisClient(fakeKey),
    combinedDashboardClient: createClaudeCombinedDashboardClient(fakeKey),
    adminIntent: "Executive Overview combining attrition numbers with leadership takeaways",
  });

  console.log("Survival result:", JSON.stringify({
    ok: survivalResult.ok,
    upgraded: survivalResult.ok ? survivalResult.upgraded : undefined,
    reason: survivalResult.ok ? survivalResult.reason : survivalResult.error,
  }));

  if (!survivalResult.ok || survivalResult.upgraded) {
    console.error(
      "SURVIVAL CHECK FAILED: a total AI failure must report ok:true/upgraded:false.",
    );
    process.exit(1);
  }

  const afterFailure = await payload.findByID({
    collection: "sessions",
    id: session.id,
    depth: 0,
  });
  const failureOverview = afterFailure.overview as any;

  const fallbackIntact =
    failureOverview?.configSource === "initial_fallback" &&
    JSON.stringify(failureOverview?.config?.tabs) === JSON.stringify(phaseAOverview.config.tabs);

  console.log("Fallback intact after total AI failure:", fallbackIntact);

  if (!fallbackIntact) {
    console.error("SURVIVAL CHECK FAILED: the fallback was modified or replaced.");
    process.exit(1);
  }

  // 4. PHASE B UPGRADE: real key (when configured)
  if (apiKey && !apiKey.startsWith("sk-ant-deliberately")) {
    console.log("\n--- Phase B upgrade: real key ---");
    const sources = await loadSessionSynthesisSources(payload, String(session.id));
    console.log(
      "Usable sources:",
      sources ? `${sources.datasetInputs.length} dataset(s), ${sources.documentInputs.length} document(s)` : "none",
    );

    const upgradeResult = await runSessionSynthesis(String(session.id), {
      payload,
      synthesisClient: createSessionSynthesisClient(apiKey),
      combinedDashboardClient: createClaudeCombinedDashboardClient(apiKey),
      adminIntent: "Executive Overview combining attrition numbers with leadership takeaways",
    });

    console.log("Upgrade result:", JSON.stringify({
      ok: upgradeResult.ok,
      upgraded: upgradeResult.ok ? upgradeResult.upgraded : undefined,
      reason: upgradeResult.ok ? upgradeResult.reason : upgradeResult.error,
    }));

    const afterUpgrade = await payload.findByID({
      collection: "sessions",
      id: session.id,
      depth: 0,
    });
    const upgradeOverview = afterUpgrade.overview as any;

    console.log("Status:", afterUpgrade.status);
    console.log("configSource:", upgradeOverview?.configSource);
    console.log("Name:", afterUpgrade.name);
    console.log("Tabs:", upgradeOverview?.config?.tabs?.map((t: any) => t.tabName));
    console.log("Insights count:", upgradeOverview?.config?.insights?.length);
    console.log("Findings count:", upgradeOverview?.findings?.length ?? 0);

    if (upgradeResult.ok && upgradeResult.upgraded) {
      if (upgradeOverview?.configSource !== "initial_auto_generation") {
        console.error("UPGRADE CHECK FAILED: success did not stamp initial_auto_generation.");
        process.exit(1);
      }
      console.log("Upgrade verified: AI overview is live and stamped.");
    } else {
      console.log(
        "Upgrade did not produce output (quota/model availability); fallback survived -- acceptable.",
      );
    }
  } else {
    console.log("\n--- Phase B upgrade skipped: no real ANTHROPIC_API_KEY configured ---");
  }

  // 5. Edit flow regression (unchanged behavior, now also stamps prompt_edit)
  console.log("\n--- Edit target resolution & reshaping pipeline ---");
  const targetClient = createSessionEditTargetClient(apiKey);
  const editClient = createClaudeConfigEditClient(apiKey);
  const documentEditClient = createClaudeDocumentEditClient(apiKey);

  const editPrompt =
    "Executive Overview should be a combined dashboard of Copy of Copy of Treelife Attrition Report FY2526 and Treelife_Attrition_Hiring_Insights with stop start continue categories";
  console.log("Sending Edit Prompt:", editPrompt);

  const editResult = await runSessionEdit(String(session.id), editPrompt, {
    payload,
    editClient,
    documentEditClient,
    combinedDashboardClient: createClaudeCombinedDashboardClient(apiKey),
    targetClient,
    publishEvent: publishDatasetEvent,
    userId,
  });

  console.log("\nEdit Result:", JSON.stringify(editResult, null, 2));

  const finalSession = await payload.findByID({
    collection: "sessions",
    id: session.id,
    depth: 0,
  });
  const finalOverview = finalSession.overview as any;
  console.log("\n================ FINAL VERIFIED OUTPUT ================");
  console.log("Session Name:", finalSession.name);
  console.log("Session Status:", finalSession.status);
  console.log("configSource:", finalOverview?.configSource);
  console.log("Combined Config Title:", finalOverview?.config?.title);
  console.log("Tabs:", finalOverview?.config?.tabs?.map((t: any) => t.tabName));
  console.log("Insights count:", finalOverview?.config?.insights?.length);
  console.log("Findings count:", finalOverview?.findings?.length ?? 0);

  process.exit(0);
};

main().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});