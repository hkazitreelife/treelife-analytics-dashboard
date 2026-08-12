import path from "path";
import { fileURLToPath } from "url";

import { postgresAdapter } from "@payloadcms/db-postgres";
import { buildConfig } from "payload";
import sharp from "sharp";

import { Configs } from "./collections/Configs";
import { Datasets } from "./collections/Datasets";
import { Files } from "./collections/Files";
import { Jobs } from "./collections/Jobs";
import { Users } from "./collections/Users";

const dirname = path.dirname(fileURLToPath(import.meta.url));

const requireEnv = (name: string): string => {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to apps/web/.env.local and set it.`,
    );
  }

  return value;
};

/**
 * Boot-time sanity check, not a fix. ADMIN_EMAIL has been edited by hand more
 * than once, and a mismatch between the env value and the seeded user surfaces
 * only as an unexplained 401 at login. This names the problem at startup and
 * deliberately does not correct the env file, so the next accidental edit is
 * visible immediately rather than during testing.
 */
const warnOnAdminMismatch = async (payload: {
  find: (args: unknown) => Promise<{ docs: { email: string }[] }>;
  logger: { warn: (message: string) => void };
}): Promise<void> => {
  const adminEmail = process.env.ADMIN_EMAIL;

  if (!adminEmail) {
    payload.logger.warn(
      "ADMIN_EMAIL is not set. Admin login cannot be verified. See apps/web/.env.local.",
    );

    return;
  }

  try {
    const match = await payload.find({
      collection: "users",
      where: { email: { equals: adminEmail } },
      limit: 1,
      depth: 0,
    });

    if (match.docs.length > 0) {
      return;
    }

    const all = await payload.find({
      collection: "users",
      limit: 10,
      depth: 0,
    });

    const existing = all.docs.map((user) => user.email);

    payload.logger.warn(
      existing.length === 0
        ? `ADMIN_EMAIL is "${adminEmail}" but no user exists yet. Run: pnpm --filter @analytics/web seed:admin`
        : `ADMIN_EMAIL is "${adminEmail}" but no user has that email. Existing users: ${existing.join(", ")}. Login with ADMIN_EMAIL will return 401 until these agree. The env file has not been changed.`,
    );
  } catch (error: unknown) {
    payload.logger.warn(
      `Could not verify the seeded admin against ADMIN_EMAIL: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
    // Payload's own RootLayout reads this to decide whether to suppress
    // React's hydration-mismatch warning on the <html> tag it renders. The
    // mismatch in question is browser extensions (Grammarly, etc.) injecting
    // their own attributes into the DOM before React hydrates -- not
    // anything this app's code controls, and not a real bug. React's own
    // hydration-mismatch error names this exact cause. Payload has no
    // equivalent knob for the <body> tag it renders, so an extension that
    // injects body-level attributes (Grammarly does) will still warn; the
    // only real fix for that half is disabling the extension for localhost.
    suppressHydrationWarning: true,
  },
  collections: [Users, Files, Datasets, Configs, Jobs],
  secret: requireEnv("PAYLOAD_SECRET"),
  db: postgresAdapter({
    pool: {
      connectionString: requireEnv("DATABASE_URI"),
    },
    // Local development pushes the schema directly. Production uses migrations.
    push: process.env.NODE_ENV !== "production",
  }),
  typescript: {
    outputFile: path.resolve(dirname, "payload-types.ts"),
  },
  onInit: async (payload) => {
    await warnOnAdminMismatch(
      payload as unknown as Parameters<typeof warnOnAdminMismatch>[0],
    );
  },
  sharp,
});
