import type { CollectionConfig } from "payload";

export const Datasets: CollectionConfig = {
  slug: "datasets",
  timestamps: true,
  admin: {
    useAsTitle: "name",
  },
  fields: [
    {
      name: "name",
      type: "text",
      required: true,
    },
    {
      name: "currentFile",
      type: "relationship",
      relationTo: "files",
    },
    {
      name: "currentFileHash",
      type: "text",
      index: true,
    },
    {
      name: "status",
      type: "select",
      required: true,
      defaultValue: "processing",
      options: [
        { label: "Processing", value: "processing" },
        { label: "Ready", value: "ready" },
        { label: "Failed", value: "failed" },
        { label: "Updating", value: "updating" },
      ],
    },
    {
      name: "tableNames",
      type: "array",
      fields: [
        {
          name: "tableName",
          type: "text",
          required: true,
        },
      ],
    },
    {
      name: "totalRows",
      type: "number",
      defaultValue: 0,
    },
    {
      name: "createdBy",
      type: "relationship",
      relationTo: "users",
    },
  ],
};
