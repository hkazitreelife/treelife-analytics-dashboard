import path from "path";
import { fileURLToPath } from "url";

import { postgresAdapter } from "@payloadcms/db-postgres";
import { s3Storage } from "@payloadcms/storage-s3";
import { buildConfig } from "payload";
import sharp from "sharp";

import { Configs } from "./collections/Configs";
import { Datasets } from "./collections/Datasets";
import { Documents } from "./collections/Documents";
import { Files } from "./collections/Files";
import { ConversationTurns } from "./collections/ConversationTurns";
import { Jobs } from "./collections/Jobs";
import { Sessions } from "./collections/Sessions";
import { Summaries } from "./collections/Summaries";
import { Users } from "./collections/Users";
import { GeminiMetadataCache } from "./collections/GeminiMetadataCache";
import { ClaudeConfigCache } from "./collections/ClaudeConfigCache";

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

const plugins = [];

if (
  process.env.S3_BUCKET &&
  process.env.S3_ACCESS_KEY_ID &&
  process.env.S3_SECRET_ACCESS_KEY
) {
  plugins.push(
    s3Storage({
      collections: {
        files: {
          prefix: process.env.S3_PREFIX ?? "media",
        },
      },
      bucket: process.env.S3_BUCKET,
      config: {
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        },
        region: process.env.S3_REGION ?? "us-east-1",
        ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
      },
    }),
  );
}

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
  collections: [Users, Files, Datasets, Configs, Jobs, Documents, Summaries, Sessions, ConversationTurns, GeminiMetadataCache, ClaudeConfigCache],
  plugins,
  secret: process.env.PAYLOAD_SECRET || "dev-payload-secret-at-least-32-chars-long",
  db: postgresAdapter({
    pool: {
      connectionString: process.env.DATABASE_URI || "postgres://dummy:dummy@localhost:5432/dummy",
    },
    // Schema is managed via push or migrations; support PAYLOAD_DB_PUSH=true for initial setup
    push: process.env.PAYLOAD_DB_PUSH === "true",
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
