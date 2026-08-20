import { getPayload } from "payload";
import config from "../payload.config";

async function main() {
  const payload = await getPayload({ config });
  
  const files = await payload.find({
    collection: "files",
    limit: 5,
    sort: "-createdAt",
    depth: 0,
  });

  const datasets = await payload.find({
    collection: "datasets",
    limit: 5,
    sort: "-createdAt",
    depth: 0,
  });

  const documents = await payload.find({
    collection: "documents",
    limit: 5,
    sort: "-createdAt",
    depth: 0,
  });

  const sessions = await payload.find({
    collection: "sessions",
    limit: 5,
    sort: "-updatedAt",
    depth: 0,
  });

  console.log("\n=== RECENT UPLOADED FILES ===");
  for (const f of files.docs) {
    console.log(`- File: "${f.filename}" (ID: ${f.id}) | Created: ${f.createdAt}`);
  }

  console.log("\n=== RECENT DATASETS ===");
  for (const d of datasets.docs) {
    console.log(`- Dataset: "${d.name}" (ID: ${d.id}, status: ${d.status}) | Rows: ${d.totalRows}`);
  }

  console.log("\n=== RECENT DOCUMENTS ===");
  for (const doc of documents.docs) {
    console.log(`- Document: "${doc.name}" (ID: ${doc.id}, status: ${doc.status})`);
  }

  console.log("\n=== DASHBOARD SESSIONS ===");
  for (const s of sessions.docs) {
    console.log(`- Session URL: /sessions/${s.id} | Name: "${s.name}" | Status: ${s.status}`);
  }
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
