import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import type { CollectionConfig } from "payload";

const dirname = path.dirname(fileURLToPath(import.meta.url));

const mediaDirectory = process.env.MEDIA_DIR
  ? path.resolve(process.env.MEDIA_DIR)
  : process.env.VERCEL
    ? path.join(os.tmpdir(), "media")
    : path.resolve(dirname, "../media");

try {
  if (!fs.existsSync(mediaDirectory)) {
    fs.mkdirSync(mediaDirectory, { recursive: true });
  }
} catch {
  // Ignore in read-only environment
}

const ALLOWED_MIME_TYPES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "application/csv",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

/**
 * Upload collection.
 *
 * Payload's upload feature already provides `filename`, `mimeType`, `filesize`
 * and `url` as reserved fields, so they are deliberately not redeclared here.
 * Only the fields Payload does not supply are defined below.
 */
export const Files: CollectionConfig = {
  slug: "files",
  timestamps: true,
  admin: {
    useAsTitle: "filename",
  },
  upload: {
    staticDir: mediaDirectory,
    mimeTypes: ALLOWED_MIME_TYPES,
    disableLocalStorage: Boolean(process.env.S3_BUCKET),
  },
  fields: [
    {
      name: "sha256",
      type: "text",
      index: true,
      admin: {
        description: "SHA-256 of the raw file bytes. File identity, not the filename.",
      },
    },
    {
      name: "storagePath",
      type: "text",
    },
    {
      name: "uploadedBy",
      type: "relationship",
      relationTo: "users",
    },
    {
      name: "dataBase64",
      type: "textarea",
      admin: {
        hidden: true,
      },
    },
  ],
};
