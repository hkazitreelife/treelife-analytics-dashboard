import type { CollectionConfig } from "payload";

export const Jobs: CollectionConfig = {
  slug: "jobs",
  timestamps: true,
  admin: {
    useAsTitle: "id",
  },
  fields: [
    {
      name: "file",
      type: "relationship",
      relationTo: "files",
      required: true,
    },
    {
      name: "dataset",
      type: "relationship",
      relationTo: "datasets",
      index: true,
    },
    {
      name: "fileHash",
      type: "text",
      index: true,
    },
    {
      name: "status",
      type: "select",
      required: true,
      defaultValue: "queued",
      index: true,
      options: [
        { label: "Queued", value: "queued" },
        { label: "Processing", value: "processing" },
        { label: "Validating", value: "validating" },
        { label: "Generating config", value: "generating_config" },
        { label: "Completed", value: "completed" },
        { label: "Failed", value: "failed" },
        { label: "Duplicate no-op", value: "duplicate_noop" },
      ],
    },
    {
      name: "retryCount",
      type: "number",
      required: true,
      defaultValue: 0,
    },
    {
      name: "error",
      type: "textarea",
    },
    {
      name: "completedAt",
      type: "date",
    },
  ],
};
