import {
  buildDatasetMetadata,
  type DocumentSectionShape,
  type NormalizedTableShape,
} from "@analytics/shared";
import type { Payload } from "payload";

/**
 * Prompt 15.0 Part 2. Shared source-loading for the universal session
 * chat/edit paths (lib/sessionChat.ts, lib/sessionEdit.ts) -- reads a
 * session's real datasetIds/documentIds and their already-stored data, the
 * same read-only lookups lib/sessionSynthesis.ts already does for
 * cross-source synthesis, factored out so those two new files don't each
 * duplicate it. lib/sessionSynthesis.ts itself is left as-is (already
 * verified, not worth touching for this).
 */

export const relationshipIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) =>
    typeof entry === "object" && entry !== null && "id" in entry
      ? String((entry as { id: unknown }).id)
      : String(entry),
  );
};

export type LoadedDatasetSource = {
  datasetId: string;
  datasetName: string;
  metadata: unknown;
  tables: NormalizedTableShape[];
};

export type LoadedDocumentSource = {
  documentId: string;
  documentName: string;
  fullText: string;
  sections: DocumentSectionShape[];
};

type StoredDatasetData = { tables?: NormalizedTableShape[]; relationships?: unknown[] };
type StoredDocumentData = { fullText?: string; sections?: DocumentSectionShape[] };

export const loadSessionSources = async (
  payload: Payload,
  datasetIds: string[],
  documentIds: string[],
): Promise<{ datasets: LoadedDatasetSource[]; documents: LoadedDocumentSource[] }> => {
  const datasets: LoadedDatasetSource[] = [];

  for (const id of datasetIds) {
    let dataset;

    try {
      dataset = await payload.findByID({ collection: "datasets", id, depth: 0 });
    } catch {
      continue;
    }

    const stored = dataset.data as StoredDatasetData | null;
    const tables = stored?.tables ?? [];

    if (tables.length === 0) {
      continue;
    }

    datasets.push({
      datasetId: id,
      datasetName: dataset.name,
      metadata: buildDatasetMetadata(id, dataset.name, tables, stored?.relationships ?? []),
      tables,
    });
  }

  const documents: LoadedDocumentSource[] = [];

  for (const id of documentIds) {
    let document;

    try {
      document = await payload.findByID({ collection: "documents", id, depth: 0 });
    } catch {
      continue;
    }

    const stored = document.data as StoredDocumentData | null;
    const fullText = stored?.fullText;
    const sections = stored?.sections ?? [];

    if (!fullText || sections.length === 0) {
      continue;
    }

    documents.push({ documentId: id, documentName: document.name, fullText, sections });
  }

  return { datasets, documents };
};
