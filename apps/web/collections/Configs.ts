import type { CollectionConfig } from "payload";

export const Configs: CollectionConfig = {
  slug: "configs",
  timestamps: true,
  admin: {
    useAsTitle: "id",
  },
  fields: [
    {
      name: "dataset",
      type: "relationship",
      relationTo: "datasets",
      required: true,
      index: true,
    },
    {
      name: "version",
      type: "number",
      required: true,
      defaultValue: 1,
    },
    {
      name: "config",
      type: "json",
      admin: {
        description: "Dashboard config. Never contains dataset rows.",
      },
    },
    {
      name: "insights",
      type: "json",
    },
    {
      name: "generatedBy",
      type: "relationship",
      relationTo: "users",
    },
  ],
};
