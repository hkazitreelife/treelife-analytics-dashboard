import type { CollectionConfig } from "payload";

export const GeminiMetadataCache: CollectionConfig = {
  slug: "geminiMetadataCache",
  timestamps: true,
  admin: {
    useAsTitle: "hash",
  },
  fields: [
    {
      name: "hash",
      type: "text",
      required: true,
      unique: true,
      index: true,
    },
    {
      name: "metadata",
      type: "json",
      required: true,
    },
  ],
};
