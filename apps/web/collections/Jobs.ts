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
      // Section 10.0: set instead of `dataset` for a job processing a
      // PDF/PPTX/DOCX through the narrative-document pipeline. A job has
      // exactly one of dataset/document set, never both -- which pipeline
      // owns it is decided at upload time (isDocumentCandidateMimeType),
      // before this row is even created.
      name: "document",
      type: "relationship",
      relationTo: "documents",
      index: true,
    },
    {
      name: "fileHash",
      type: "text",
      index: true,
    },
    {
      // Prompt 15.0 Part 4: whatever the admin typed in /new alongside this
      // upload, if anything. Read by the worker and passed into the initial
      // config-generation (dataset) or summary-generation (document) call as
      // extra framing, never as a replacement for the deterministic
      // extraction/validation pipeline itself.
      name: "intentPrompt",
      type: "textarea",
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
