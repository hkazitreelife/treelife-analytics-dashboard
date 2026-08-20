import { getPayload } from "payload";
import config from "../payload.config";

async function main() {
  const payload = await getPayload({ config });
  
  const session = await payload.findByID({
    collection: "sessions",
    id: 20,
    depth: 2,
  });

  console.log("Session ID 20 details:");
  console.log("Name:", session.name);
  console.log("Status:", session.status);
  
  if (session.overview?.config) {
    console.log("Config Title:", session.overview.config.title);
    const tabs = session.overview.config.tabs || [];
    for (const t of tabs) {
      console.log(`\nTab: ${t.tabName} (${t.tabId})`);
      console.log("Widgets:");
      t.widgets?.forEach((w: any) => {
        console.log(` - [${w.type}] ${w.title} -> sourceTable: ${w.sourceTable}`);
      });
    }
  } else {
    console.log("No config found in session.overview");
  }

  if (session.datasets && session.datasets.length > 0) {
    const datasetId = (session.datasets[0] as any).id || session.datasets[0];
    const dataset = await payload.findByID({
      collection: "datasets",
      id: datasetId,
      depth: 2,
    });
    console.log("\nDataset details:");
    console.log("Name:", dataset.name);
    const tables = (dataset.data as any)?.tables || [];
    console.log("Tables:", tables.map((t: any) => ({ name: t.name, rowCount: t.rowCount, role: t.tableRole })));
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
