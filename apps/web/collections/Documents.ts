import type { CollectionConfig } from "payload";

/**
 * Section 10.0. Parallel to Datasets, never inside it: a narrative document
 * (fullText + sections) and a normalized dataset (tables[] + relationships[])
 * are structurally different contracts, so this is its own collection with
 * its own lifecycle rather than a documentKind discriminator bolted onto
 * Datasets -- see normalizedDocument.ts's doc comment for the full reasoning.
 */
export const Documents: CollectionConfig = {
  slug: "documents",
  timestamps: true,
  admin: {
    useAsTitle: "name",
  },
  fields: [
    {
      name: "name",
      type: "text",
      required: true,
      index: true,
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
      index: true,
      options: [
        { label: "Processing", value: "processing" },
        { label: "Ready", value: "ready" },
        { label: "Failed", value: "failed" },
        // Section 10.1: set while a filename-collision "update existing"
        // re-upload is being re-extracted and re-summarized. Mirrors
        // Datasets.status's "updating" exactly.
        { label: "Updating", value: "updating" },
      ],
    },
    {
      name: "data",
      type: "json",
      admin: {
        description:
          "The normalized narrative document: documentId, sourceFile, fullText, and sections[] from the Section 10.0 Step 2 contract. Written only after full validation succeeds.",
      },
    },
    {
      name: "lastError",
      type: "textarea",
      admin: {
        description:
          "The technical error from the most recent failed job against this document, including the explicit 'this file appears tabular' verdict when Gemini classifies it that way.",
      },
    },
    {
      name: "createdBy",
      type: "relationship",
      relationTo: "users",
    },
  ],
};
