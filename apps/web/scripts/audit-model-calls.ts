import { getPayload } from "payload";
import config from "../payload.config";

async function main() {
  const payload = await getPayload({ config });

  // Today is August 17, 2026 (local time is 19:09). We'll search for anything created since August 17, 2026 00:00:00.
  const todayStart = new Date("2026-08-17T00:00:00.000Z");

  console.log(`Auditing model calls since: ${todayStart.toISOString()}\n`);

  // Query jobs
  const jobs = await payload.find({
    collection: "jobs",
    where: {
      createdAt: {
        greater_than_equal: todayStart.toISOString(),
      },
    },
    limit: 1000,
    depth: 1,
  });

  // Query conversation turns
  const turns = await payload.find({
    collection: "conversation-turns",
    where: {
      createdAt: {
        greater_than_equal: todayStart.toISOString(),
      },
    },
    limit: 1000,
    depth: 1,
  });

  // Query configs
  const configs = await payload.find({
    collection: "configs",
    where: {
      createdAt: {
        greater_than_equal: todayStart.toISOString(),
      },
    },
    limit: 1000,
    depth: 1,
  });

  console.log("=== JOBS SUMMARY (Ingest / Ingestion Runs) ===");
  console.log(`Total Jobs created today: ${jobs.totalDocs}`);

  const jobsByStatus: Record<string, number> = {};
  let geminiCallsCount = 0;
  let claudeCallsCountFromJobs = 0;

  jobs.docs.forEach((job: any) => {
    const status = job.status || "unknown";
    jobsByStatus[status] = (jobsByStatus[status] || 0) + 1;

    // Completed jobs run:
    // - 1 Gemini call for metadata extraction
    // - 1 Claude call for dashboard configuration generation (if it is a dataset) or summary (if document)
    // Failed jobs might run Gemini but not Claude, or fail during validation. Let's count them:
    if (status === "completed") {
      geminiCallsCount += 1;
      claudeCallsCountFromJobs += 1;
    } else if (status === "failed") {
      // If it failed at generating_config, it did Gemini but not Claude, or Claude failed.
      geminiCallsCount += 1;
      if (job.error?.includes("Claude") || job.error?.includes("config")) {
        claudeCallsCountFromJobs += 1;
      }
    } else if (status === "processing" || status === "generating_config" || status === "validating") {
      geminiCallsCount += 1;
    }
  });

  console.log("Jobs by Status:", jobsByStatus);

  console.log("\n=== CONVERSATION TURNS SUMMARY (Chat & Edit) ===");
  console.log(`Total Turns created today: ${turns.totalDocs}`);

  const turnsByKind: Record<string, number> = {};
  const turnsByStatus: Record<string, number> = {};
  let claudeCallsCountFromTurns = 0;

  turns.docs.forEach((turn: any) => {
    turnsByKind[turn.kind] = (turnsByKind[turn.kind] || 0) + 1;
    turnsByStatus[turn.status] = (turnsByStatus[turn.status] || 0) + 1;
    
    // Each Turn makes exactly 1 Claude request (whether chat or edit)
    claudeCallsCountFromTurns += 1;
  });

  console.log("Turns by Kind (Chat/Edit):", turnsByKind);
  console.log("Turns by Outcome Status:", turnsByStatus);

  console.log("\n=== ESTIMATED TOTAL MODEL REQUESTS ===");
  console.log(`1. Gemini Requests (Structural extraction/metadata):`);
  console.log(`   - Approx. ${geminiCallsCount} runs (via Jobs processing)`);
  console.log(`2. Claude Requests (Dashboard configs, chat answers, and edits):`);
  console.log(`   - Ingestion config/summary: ${claudeCallsCountFromJobs}`);
  console.log(`   - Chat / Edit interaction: ${claudeCallsCountFromTurns}`);
  console.log(`   - Total Claude requests: ${claudeCallsCountFromJobs + claudeCallsCountFromTurns}`);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
