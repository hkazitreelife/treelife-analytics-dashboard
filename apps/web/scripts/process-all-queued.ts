import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPayload } from "payload";
import config from "../payload.config";
import { Redis } from "ioredis";
import {
  INGESTION_QUEUE_NAME,
  DOCUMENT_INGESTION_QUEUE_NAME,
  redisConnectionOptions,
} from "@analytics/shared";
import { Queue } from "bullmq";
import { createGeminiClient } from "../../../worker/src/services/gemini";
import { createClaudeConfigClient } from "../../../worker/src/services/claudeConfig";
import { createDatasetLock } from "../../../worker/src/services/datasetLock";
import { createDatasetEventPublisher } from "../../../worker/src/services/events";
import { processIngestionJob } from "../../../worker/src/processors/ingestion";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const mediaDir = path.resolve(dirname, "../media");

async function main() {
  console.log("Starting direct job processor...");
  const payload = await getPayload({ config });
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  const connection = new Redis(redisUrl, redisConnectionOptions);

  const geminiApiKey = process.env.GEMINI_API_KEY!;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY!;

  const gemini = createGeminiClient(geminiApiKey);
  const claude = createClaudeConfigClient(anthropicApiKey);
  const datasetLock = createDatasetLock(connection);
  const events = createDatasetEventPublisher(connection);
  const queue = new Queue(INGESTION_QUEUE_NAME, { connection });

  const queuedJobs = await payload.find({
    collection: "jobs",
    where: { status: { equals: "queued" } },
    sort: "createdAt",
    limit: 10,
    depth: 0,
  });

  console.log(`Found ${queuedJobs.docs.length} queued jobs.`);

  for (const job of queuedJobs.docs) {
    if (!job.dataset) continue;
    console.log(`\n========================================`);
    console.log(`Processing Job ID: ${job.id} for Dataset: ${job.dataset}...`);
    
    try {
      const dataset = await payload.findByID({
        collection: "datasets",
        id: job.dataset,
        depth: 0,
      });

      const file = await payload.findByID({
        collection: "files",
        id: job.file as any,
        depth: 0,
      });

      console.log(`File: ${file.filename} | Dataset: ${dataset.name}`);

      await processIngestionJob(
        {
          jobId: String(job.id),
          datasetId: String(dataset.id),
          fileId: String(file.id),
          filename: file.filename,
          intentPrompt: (job as any).intentPrompt,
        },
        {
          payload,
          gemini,
          claude,
          datasetLock,
          queue,
          events,
          mediaDir,
        }
      );

      console.log(`✓ Job ${job.id} successfully processed!`);
    } catch (err: any) {
      console.error(`✕ Job ${job.id} failed:`, err.message);
    }
  }

  const sessions = await payload.find({
    collection: "sessions",
    limit: 5,
    sort: "-updatedAt",
    depth: 0,
  });

  console.log("\n=== LATEST READY SESSIONS ===");
  for (const s of sessions.docs) {
    console.log(`- LINK: /sessions/${s.id} | Name: "${s.name}" | Status: ${s.status}`);
  }

  process.exit(0);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
