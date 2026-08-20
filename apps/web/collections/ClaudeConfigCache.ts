import type { CollectionConfig } from "payload";

export const ClaudeConfigCache: CollectionConfig = {
  slug: "claudeConfigCache",
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
      name: "config",
      type: "json",
      required: true,
    },
  ],
};
