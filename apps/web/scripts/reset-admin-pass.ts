import { getPayload } from "payload";
import config from "../payload.config.js";

async function main() {
  const payload = await getPayload({ config });
  const email = process.env.ADMIN_EMAIL || "admin@treelife.com";
  const password = process.env.ADMIN_PASSWORD || "AdminPassword123!";

  console.log(`Setting password for ${email}...`);

  const existing = await payload.find({
    collection: "users",
    where: { email: { equals: email } },
    limit: 1,
  });

  if (existing.totalDocs > 0) {
    const user = existing.docs[0];
    await payload.update({
      collection: "users",
      id: user!.id,
      data: {
        password: password,
      },
    });
    console.log(`Successfully updated password for ${email}`);
  } else {
    await payload.create({
      collection: "users",
      data: {
        email: email,
        password: password,
        role: "admin",
      },
    });
    console.log(`Successfully created admin user ${email}`);
  }
  process.exit(0);
}

main().catch(err => {
  console.error("Error setting password:", err);
  process.exit(1);
});
