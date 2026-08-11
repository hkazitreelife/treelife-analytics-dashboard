import path from "path";
import { fileURLToPath } from "url";

import type { CollectionConfig } from "payload";

const dirname = path.dirname(fileURLToPath(import.meta.url));

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
    staticDir: path.resolve(dirname, "../media"),
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
  ],
};
