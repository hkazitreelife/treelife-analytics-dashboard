/**
 * Prompt 12.0, unified by Prompt 15.0: Session is now the one universal,
 * addressable container -- a single-source session IS a dataset/document,
 * not a separate concept, so the sidebar (AppShell.tsx) shows one list of
 * these instead of three separate Dataset/Document/Session sections.
 */

export type SingleSourceInfo = {
  kind: "dataset" | "document";
  fileType: string | null;
  totalRows: number | null;
  keyPointsCount: number | null;
} | null;

export type SessionSidebarEntry = {
  id: string;
  name: string;
  status: string;
  datasetCount: number;
  documentCount: number;
  singleSource: SingleSourceInfo;
  findingsCount: number | null;
};

/**
 * What a session's right panel is chatting/editing against. For a
 * single-source session this is exactly that one source; for a
 * multi-source session it's the whole session (the universal chat/edit
 * endpoints decide internally which underlying source(s) actually get
 * touched -- see lib/sessionChat.ts / lib/sessionEdit.ts).
 */
export type ActiveSource = {
  sessionId: string;
  name: string;
  singleSource: SingleSourceInfo;
};
