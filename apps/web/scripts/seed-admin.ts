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

  if (
    password.length < 12 ||
    !/[A-Z]/.test(password) ||
    !/[a-z]/.test(password) ||
    !/[0-9]/.test(password) ||
    !/[^A-Za-z0-9]/.test(password)
  ) {
    throw new Error(
      "ADMIN_PASSWORD must be at least 12 characters and contain uppercase, lowercase, numbers, and special characters.",
    );
  }

  const payload = await getPayload({ config });

  const existing = await payload.find({
    collection: "users",
    where: { email: { equals: email } },
    limit: 1,
  });

  if (existing.totalDocs > 0) {
    const user = existing.docs[0];
    await payload.delete({
      collection: "users",
      id: user.id,
    });
    console.log(`Deleted existing user: ${email}`);
  }

  await payload.create({
    collection: "users",
    data: {
      email,
      password,
      firstName: "System",
      lastName: "Admin",
      role: "admin",
      isActive: true,
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
