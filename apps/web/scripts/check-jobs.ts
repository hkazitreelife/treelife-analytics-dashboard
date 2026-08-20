import { getPayload } from "payload";
import config from "../payload.config";

async function main() {
  const payload = await getPayload({ config });
  
  const jobs = await payload.find({
    collection: "jobs",
    limit: 10,
    sort: "-createdAt",
    depth: 0,
  });

  console.log("\n=== RECENT JOBS ===");
  for (const j of jobs.docs) {
    console.log(`- Job ID: ${j.id} | Status: ${j.status} | Stage: ${j.stage} | Dataset: ${j.dataset} | Error: ${j.error}`);
  }
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
