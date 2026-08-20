import { getPayload } from "payload";
import config from "../payload.config";

const main = async () => {
  const payload = await getPayload({ config });

  console.log("Cleaning up conversation turns...");
  try {
    await payload.delete({
      collection: "conversation-turns",
      where: { id: { exists: true } },
    });
  } catch (err) {
    console.log("No conversation turns to delete or error:", err);
  }

  console.log("Cleaning up sessions...");
  try {
    await payload.delete({
      collection: "sessions",
      where: { id: { exists: true } },
    });
  } catch (err) {
    console.log("Session deletion note:", err);
  }

  console.log("Successfully deleted all sessions while preserving datasets and documents.");
  process.exit(0);
};

main().catch((err) => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});
