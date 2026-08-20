import type { CollectionConfig } from "payload";

/**
 * Prompt 15.0 Part 2. Persistent conversation memory, per session, not per
 * page load: every chat question and every edit request against a session
 * -- across its full lifetime -- gets one row here, in order (timestamps
 * are Payload's own createdAt). Reopening a session reads this collection
 * to restore its complete history instead of starting blank.
 *
 * Not scoped to a single dataset/document: a session can wrap several
 * sources, so `targetSourceKind`/`targetSourceId` record which underlying
 * source an edit actually applied to (or which sources a chat answer's
 * evidence came from, informationally) -- null for a single-source session,
 * where there is only ever one possible target.
 */
export const ConversationTurns: CollectionConfig = {
  slug: "conversation-turns",
  timestamps: true,
  admin: {
    useAsTitle: "id",
  },
  fields: [
    {
      name: "session",
      type: "relationship",
      relationTo: "sessions",
      required: true,
      index: true,
    },
    {
      name: "kind",
      type: "select",
      required: true,
      options: [
        { label: "Chat", value: "chat" },
        { label: "Edit", value: "edit" },
      ],
    },
    {
      name: "message",
      type: "textarea",
      required: true,
    },
    {
      // For an edit that actually resolved to one source (not a
      // clarification request), which one -- informational, and what a
      // multi-source edit's routing decision actually was.
      name: "targetSourceKind",
      type: "select",
      options: [
        { label: "Dataset", value: "dataset" },
        { label: "Document", value: "document" },
      ],
    },
    {
      name: "targetSourceId",
      type: "text",
    },
    {
      name: "status",
      type: "select",
      required: true,
      options: [
        { label: "Answered", value: "answered" },
        { label: "Edit applied", value: "edit_applied" },
        { label: "Needs clarification", value: "needs_clarification" },
        { label: "Error", value: "error" },
      ],
    },
    {
      name: "response",
      type: "json",
      admin: {
        description:
          "The full result shown to the user: directAnswer+metrics+citations for chat, configVersion/summaryVersion for an applied edit, the clarifying question for needs_clarification, or the error message.",
      },
    },
    {
      name: "createdBy",
      type: "relationship",
      relationTo: "users",
    },
  ],
};
