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

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
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
  sharp,
});
