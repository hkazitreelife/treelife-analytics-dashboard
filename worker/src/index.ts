import "dotenv/config";
import { Worker, type Job } from "bullmq";
import { Pool } from "pg";
import * as XLSX from "xlsx";

import {
  QUEUE_NAMES,
  createRedisConnection,
  type DatasetIngestionJobData,
} from "./queue.js";
import { downloadFileBuffer } from "./services/storage.js";
import {
  extractMetadataWithGemini,
  generateDashboardWithClaude,
} from "./services/ai.js";

// Initialize PostgreSQL Connection Pool
const createPgPool = (): Pool => {
  const connectionString =
    process.env.DATABASE_URI ||
    "postgresql://postgres:postgres@127.0.0.1:5432/analytics_dashboard";

  const isTls =
    connectionString.includes("sslmode=require") ||
    connectionString.includes("neon.tech") ||
    connectionString.includes("supabase.co");

  return new Pool({
    connectionString,
    ssl: isTls ? { rejectUnauthorized: false } : undefined,
    max: 10,
    idleTimeoutMillis: 30000,
  });
};

const pgPool = createPgPool();

/**
 * Updates a job record status and error details in PostgreSQL.
 */
const updateJobStatus = async (
  jobId: string,
  status: "pending" | "processing" | "ready" | "failed",
  errorMessage?: string,
): Promise<void> => {
  try {
    const query = `
      UPDATE jobs 
      SET status = $1, error = $2, updated_at = NOW() 
      WHERE id = $3
    `;
    await pgPool.query(query, [status, errorMessage || null, jobId]);
  } catch (err: unknown) {
    console.error(`[DB] Failed to update job ${jobId} status to ${status}:`, err);
  }
};

/**
 * Parses an Excel or CSV file buffer into structured table schemas.
 */
const parseWorkbookBuffer = (
  buffer: Buffer,
): Array<{ name: string; columns: string[]; rowCount: number; sampleRows: any[] }> => {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const tables: Array<{ name: string; columns: string[]; rowCount: number; sampleRows: any[] }> = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    const rawRows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: null });
    if (rawRows.length === 0) continue;

    const firstRow = rawRows[0] || {};
    const columns = Object.keys(firstRow);

    tables.push({
      name: sheetName,
      columns,
      rowCount: rawRows.length,
      sampleRows: rawRows.slice(0, 10),
    });
  }

  return tables;
};

/**
 * Core processing function for dataset ingestion jobs.
 */
const processDatasetIngestionJob = async (job: Job<DatasetIngestionJobData>): Promise<any> => {
  const { jobId, fileId, datasetId, fileKey, fileName, intentPrompt } = job.data;
  console.log(`[Worker] 🚀 Started processing job ${job.id} (Job ID: ${jobId}, File: ${fileName || fileKey})`);

  try {
    // Step 1: Update status to 'processing'
    await updateJobStatus(jobId, "processing");

    // Step 2: Download file buffer from S3 / Cloudflare R2
    const targetKey = fileKey || fileName || fileId;
    console.log(`[Worker] 📥 Downloading file "${targetKey}" from storage...`);
    const { buffer } = await downloadFileBuffer(targetKey);

    // Step 3: Parse spreadsheet data
    console.log(`[Worker] 📊 Parsing spreadsheet workbook tables...`);
    const tables = parseWorkbookBuffer(buffer);

    if (tables.length === 0) {
      throw new Error(`The uploaded file "${fileName || targetKey}" contains no valid sheets or tabular data.`);
    }

    // Step 4: Extract semantic metadata with Gemini 2.5 Flash
    console.log(`[Worker] 🧠 Calling Gemini API for metadata and domain extraction...`);
    const extractedMetadata = await extractMetadataWithGemini(
      tables.map((t) => ({ name: t.name, columns: t.columns, sampleRows: t.sampleRows })),
    );

    // Step 5: Generate executive dashboard layout with Claude 3.5 Sonnet
    console.log(`[Worker] 🎨 Calling Claude API for executive dashboard layout generation...`);
    const dashboardLayout = await generateDashboardWithClaude(
      extractedMetadata,
      tables.map((t) => ({ name: t.name, columns: t.columns, rowCount: t.rowCount })),
      intentPrompt,
    );

    // Step 6: Persist results into PostgreSQL
    console.log(`[Worker] 💾 Saving generated dashboard config and dataset metadata into PostgreSQL...`);
    if (datasetId) {
      await pgPool.query(
        `UPDATE datasets 
         SET status = 'ready', metadata = $1, updated_at = NOW() 
         WHERE id = $2`,
        [JSON.stringify({ ...extractedMetadata, tables }), datasetId],
      );

      await pgPool.query(
        `INSERT INTO configs (dataset_id, config, created_at, updated_at) 
         VALUES ($1, $2, NOW(), NOW())
         ON CONFLICT (dataset_id) DO UPDATE SET config = $2, updated_at = NOW()`,
        [datasetId, JSON.stringify(dashboardLayout)],
      );
    }

    // Step 7: Finalize job status to 'ready'
    await updateJobStatus(jobId, "ready");
    console.log(`[Worker] ✅ Job ${jobId} successfully completed!`);

    return {
      status: "ready",
      datasetId,
      metadata: extractedMetadata,
      layout: dashboardLayout,
    };
  } catch (error: unknown) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[Worker] ❌ Job ${jobId} failed:`, errorMsg);

    // Update job status to 'failed'
    await updateJobStatus(jobId, "failed", errorMsg);
    throw error;
  }
};

/**
 * Bootstraps and starts the BullMQ Worker processes.
 */
export const startWorker = async (): Promise<void> => {
  console.log("==========================================");
  console.log("🚀 Starting Treelife AI Background Worker");
  console.log("==========================================");

  const redisConnection = createRedisConnection();

  redisConnection.on("connect", () => {
    console.log("[Redis] 🟢 Connected to Redis successfully.");
  });

  redisConnection.on("error", (err) => {
    console.error("[Redis] 🔴 Redis connection error:", err.message);
  });

  // Start workers on both generic and legacy queue names
  const queuesToListen = [
    QUEUE_NAMES.DATASET_INGESTION,
    QUEUE_NAMES.INGESTION,
    QUEUE_NAMES.DOCUMENT_INGESTION,
  ];

  const workers: Worker[] = queuesToListen.map((queueName) => {
    console.log(`[Queue] 👂 Listening for jobs on queue: "${queueName}"`);

    const worker = new Worker(queueName, processDatasetIngestionJob, {
      connection: redisConnection,
      concurrency: 5,
    });

    worker.on("completed", (job) => {
      console.log(`[Worker] Job ${job.id} on queue "${queueName}" completed.`);
    });

    worker.on("failed", (job, err) => {
      console.error(`[Worker] Job ${job?.id} on queue "${queueName}" failed:`, err.message);
    });

    return worker;
  });

  // Graceful shutdown handling
  const shutdown = async (signal: string) => {
    console.log(`\n[Worker] 🛑 Received ${signal}. Gracefully closing workers and connections...`);
    try {
      await Promise.all(workers.map((w) => w.close()));
      await redisConnection.quit();
      await pgPool.end();
      console.log("[Worker] 🟢 Shutdown complete.");
      process.exit(0);
    } catch (err) {
      console.error("[Worker] 🔴 Error during shutdown:", err);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

// Start the worker process
startWorker().catch((err) => {
  console.error("[Worker] 💥 Fatal bootstrap error:", err);
  process.exit(1);
});
