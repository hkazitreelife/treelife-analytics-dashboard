import fs from "fs";
import path from "path";
import { getPayload } from "payload";
import config from "../payload.config";

async function main() {
  const payload = await getPayload({ config });

  console.log("=== CLEARING NIMBUS DATABASE ENTRIES (WITH CONSTRAINTS RESOLVED) ===");

  // 1. Find sessions containing "Nimbus"
  const sessions = await payload.find({
    collection: "sessions",
    where: {
      name: {
        contains: "Nimbus",
      },
    },
    limit: 100,
  });
  console.log(`Found ${sessions.totalDocs} sessions matching 'Nimbus'`);

  // 2. Delete conversation turns for those sessions first
  for (const sessionDoc of sessions.docs) {
    const turns = await payload.find({
      collection: "conversation-turns",
      where: {
        session: {
          equals: sessionDoc.id,
        },
      },
      limit: 1000,
    });
    console.log(`Found ${turns.totalDocs} conversation turns for session ID ${sessionDoc.id}`);
    for (const turn of turns.docs) {
      await payload.delete({
        collection: "conversation-turns",
        id: turn.id,
      });
      console.log(`Deleted conversation turn ID: ${turn.id}`);
    }
  }

  // 3. Find datasets containing "Nimbus"
  const datasets = await payload.find({
    collection: "datasets",
    where: {
      name: {
        contains: "Nimbus",
      },
    },
    limit: 100,
  });
  console.log(`Found ${datasets.totalDocs} datasets matching 'Nimbus'`);

  // 4. Delete configs and jobs referencing those datasets
  for (const datasetDoc of datasets.docs) {
    const configs = await payload.find({
      collection: "configs",
      where: {
        dataset: {
          equals: datasetDoc.id,
        },
      },
      limit: 100,
    });
    console.log(`Found ${configs.totalDocs} configs for dataset ID ${datasetDoc.id}`);
    for (const conf of configs.docs) {
      await payload.delete({
        collection: "configs",
        id: conf.id,
      });
      console.log(`Deleted config ID: ${conf.id}`);
    }

    const jobs = await payload.find({
      collection: "jobs",
      where: {
        dataset: {
          equals: datasetDoc.id,
        },
      },
      limit: 100,
    });
    console.log(`Found ${jobs.totalDocs} jobs for dataset ID ${datasetDoc.id}`);
    for (const job of jobs.docs) {
      await payload.delete({
        collection: "jobs",
        id: job.id,
      });
      console.log(`Deleted job ID: ${job.id}`);
    }
  }

  // 5. Find documents containing "Nimbus"
  const documents = await payload.find({
    collection: "documents",
    where: {
      name: {
        contains: "Nimbus",
      },
    },
    limit: 100,
  });
  console.log(`Found ${documents.totalDocs} documents matching 'Nimbus'`);

  // 6. Delete jobs referencing those documents
  for (const doc of documents.docs) {
    const jobs = await payload.find({
      collection: "jobs",
      where: {
        document: {
          equals: doc.id,
        },
      },
      limit: 100,
    });
    console.log(`Found ${jobs.totalDocs} jobs for document ID ${doc.id}`);
    for (const job of jobs.docs) {
      await payload.delete({
        collection: "jobs",
        id: job.id,
      });
      console.log(`Deleted job ID: ${job.id}`);
    }
  }

  // 7. Delete sessions, datasets, documents
  for (const sessionDoc of sessions.docs) {
    await payload.delete({
      collection: "sessions",
      id: sessionDoc.id,
    });
    console.log(`Deleted session: ${sessionDoc.name} (ID: ${sessionDoc.id})`);
  }

  for (const datasetDoc of datasets.docs) {
    await payload.delete({
      collection: "datasets",
      id: datasetDoc.id,
    });
    console.log(`Deleted dataset: ${datasetDoc.name} (ID: ${datasetDoc.id})`);
  }

  for (const doc of documents.docs) {
    await payload.delete({
      collection: "documents",
      id: doc.id,
    });
    console.log(`Deleted document: ${doc.name} (ID: ${doc.id})`);
  }

  // 8. Delete files records
  const files = await payload.find({
    collection: "files",
    where: {
      filename: {
        contains: "Nimbus",
      },
    },
    limit: 100,
  });
  console.log(`Found ${files.totalDocs} file records matching 'Nimbus'`);
  for (const doc of files.docs) {
    await payload.delete({
      collection: "files",
      id: doc.id,
    });
    console.log(`Deleted file record: ${doc.filename} (ID: ${doc.id})`);
  }

  // 9. Delete local media files
  console.log("\n=== CLEARING NIMBUS LOCAL MEDIA FILES ===");
  const mediaDir = path.join(process.cwd(), "media");
  if (fs.existsSync(mediaDir)) {
    const filenames = fs.readdirSync(mediaDir);
    for (const filename of filenames) {
      if (filename.includes("Nimbus")) {
        const filepath = path.join(mediaDir, filename);
        try {
          fs.unlinkSync(filepath);
          console.log(`Deleted local file: ${filename}`);
        } catch (err: any) {
          console.error(`Failed to delete local file ${filename}: ${err.message}`);
        }
      }
    }
  }

  console.log("\nNimbus deletion successfully completed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
