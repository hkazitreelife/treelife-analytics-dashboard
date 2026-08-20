import type { CollectionConfig } from "payload";

/**
 * Session synthesis (ad hoc feature, requested mid-session -- see
 * packages/shared/src/schemas/sessionSynthesis.ts's doc comment). Groups
 * two or more files that were uploaded together in one landing-page batch.
 * Parallel to Datasets/Documents, never inside either: a session doesn't
 * hold any data of its own, only references to sources that already have
 * their own complete, unchanged ingestion elsewhere, plus the one thing
 * this feature adds on top -- cross-source findings.
 */
export const Sessions: CollectionConfig = {
  slug: "sessions",
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
      name: "datasets",
      type: "relationship",
      relationTo: "datasets",
      hasMany: true,
    },
    {
      name: "documents",
      type: "relationship",
      relationTo: "documents",
      hasMany: true,
    },
    {
      name: "status",
      type: "select",
      required: true,
      defaultValue: "synthesizing",
      index: true,
      options: [
        { label: "Synthesizing", value: "synthesizing" },
        { label: "Ready", value: "ready" },
        { label: "Failed", value: "failed" },
      ],
    },
    {
      name: "overview",
      type: "json",
      admin: {
        description:
          "{ findings: ResolvedSessionFindingShape[] }. Written only after every finding resolves and verifies; an empty findings array is a valid, common result.",
      },
    },
    {
      name: "lastError",
      type: "textarea",
      admin: {
        description: "The technical error from the most recent failed synthesis attempt.",
      },
    },
    {
      name: "createdBy",
      type: "relationship",
      relationTo: "users",
    },
  ],
};
