import type { CollectionConfig } from "payload";

/**
 * Section 10.0 Steps 3-4. Parallel to Configs: versioned the same way
 * (current + previous rows kept, never mutated in place, version is always
 * max-existing+1). The initial summary is one version; each "give me more"
 * (Step 4's expand endpoint) appends its new keyPoints to the existing list
 * and writes that as the next version, so the full history of what was
 * surfaced and when is kept, exactly like a Configs row never being edited
 * in place.
 */
export const Summaries: CollectionConfig = {
  slug: "summaries",
  timestamps: true,
  admin: {
    useAsTitle: "id",
  },
  fields: [
    {
      name: "document",
      type: "relationship",
      relationTo: "documents",
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
      name: "keyPoints",
      type: "json",
      admin: {
        description: "The full keyPoints[] list as of this version (Section 10.0 Step 3 contract).",
      },
    },
    {
      name: "generatedBy",
      type: "select",
      required: true,
      defaultValue: "initial_summary",
      options: [
        { label: "Initial summary", value: "initial_summary" },
        { label: "Expand", value: "expand" },
        // Section 10.2: reshapes/filters the existing keyPoints list --
        // distinct from "Expand", which only ever adds. See
        // apps/web/lib/documentPromptEdit.ts's doc comment.
        { label: "Prompt edit", value: "prompt_edit" },
      ],
    },
    {
      // Set for an expand or a prompt-edit call, never for the initial
      // auto-generated summary, so that one is never attributed to a user
      // who did not ask for it -- same rule as Configs.editedBy. Named
      // expandedBy from Section 10.0; kept as-is rather than renamed for
      // Section 10.2's prompt-edit (which also sets it) to avoid an
      // unnecessary schema-push column rename on top of the changes here.
      name: "expandedBy",
      type: "relationship",
      relationTo: "users",
    },
  ],
};
