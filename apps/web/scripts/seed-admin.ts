import { getPayload } from "payload";

import config from "../payload.config";

const main = async (): Promise<void> => {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error(
      "ADMIN_EMAIL and ADMIN_PASSWORD must be set. See apps/web/.env.local.",
    );
  }

  const payload = await getPayload({ config });

  const existing = await payload.find({
    collection: "users",
    where: { email: { equals: email } },
    limit: 1,
  });

  if (existing.totalDocs > 0) {
    console.log(`Admin user already exists: ${email}. Nothing to do.`);
    return;
  }

  await payload.create({
    collection: "users",
    data: {
      email,
      password,
      role: "admin",
    },
  });

  console.log(`Created admin user: ${email}`);
};

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error("Admin seed failed.");
    console.error(error);
    process.exit(1);
  });
