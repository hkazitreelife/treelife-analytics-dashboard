/**
 * Re-syncs the seeded admin's password with ADMIN_PASSWORD from the env file.
 * Local development convenience only.
 */
import { getPayload } from "payload";

import config from "../payload.config";

const main = async (): Promise<void> => {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD must be set.");
  }

  const payload = await getPayload({ config });

  const existing = await payload.find({
    collection: "users",
    where: { email: { equals: email } },
    limit: 1,
    depth: 0,
  });

  const user = existing.docs[0];

  if (!user) {
    await payload.create({
      collection: "users",
      data: { email, password, role: "admin" },
    });

    console.log(`Created admin user: ${email}`);
  } else {
    await payload.update({
      collection: "users",
      id: user.id,
      data: { password },
    });

    console.log(`Reset password for: ${email}`);
  }

  await payload.db.destroy?.();
  process.exit(0);
};

void main().catch((error: unknown) => {
  console.error("Reset failed:", error);
  process.exit(1);
});
