import {
  normalizedDatasetSchema,
  type GeminiMetadata,
  type NormalizedDatasetShape,
  type SupportedFileTypeValue,
} from "@analytics/shared";

import {
  deriveColumnNames,
  hashRows,
  isEmptyCell,
  stringifyCell,
  type ParsedFile,
} from "./spreadsheetParser";

/**
 * Merges the two halves of the contract:
 *   raw rows, table names, cell values   -> deterministic parser
 *   headerRowIndex, inferredType, nullable, tableRole, relationships -> Gemini
 *
 * Column names are derived here, from the raw header row the inference step
 * identified. A missing table, a missing column index, or a header index out of
 * bounds is an error, never a reason to guess or to drop data.
 */

export class MergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeError";
  }
}

export type MergeInput = {
  datasetId: string;
  sourceFile: {
    name: string;
    type: SupportedFileTypeValue;
    hash: string;
  };
  parsed: ParsedFile;
  metadata: GeminiMetadata;
};

export type MergeResult = {
  dataset: NormalizedDatasetShape;
  /** Data row count across all tables, excluding headers and preamble. */
  totalDataRows: number;
};

export const mergeDataset = ({
  datasetId,
  sourceFile,
  parsed,
  metadata,
}: MergeInput): MergeResult => {
  const metadataByTable = new Map(
    metadata.tables.map((table) => [table.tableName, table]),
  );

  const missingTables = parsed.tables
    .map((table) => table.tableName)
    .filter((name) => !metadataByTable.has(name));

  if (missingTables.length > 0) {
    throw new MergeError(
      `Metadata is missing ${missingTables.length} table(s) present in the file: ${missingTables.join(", ")}. No rows or tables may be dropped.`,
    );
  }

  let totalDataRows = 0;

  const tables = parsed.tables.map((table) => {
    const tableMetadata = metadataByTable.get(table.tableName);

    if (!tableMetadata) {
      throw new MergeError(`Metadata is missing table "${table.tableName}".`);
    }

    const { headerRowIndex } = tableMetadata;

    // Never silently default to row 0.
    if (
      !Number.isInteger(headerRowIndex) ||
      headerRowIndex < 0 ||
      headerRowIndex >= table.rawRows.length
    ) {
      throw new MergeError(
        `Table "${table.tableName}" has headerRowIndex ${String(headerRowIndex)}, which is out of bounds for ${table.rawRows.length} extracted rows.`,
      );
    }

    const headerRow = table.rawRows[headerRowIndex] ?? [];
    const dataRows = table.rawRows.slice(headerRowIndex + 1);
    const columnNames = deriveColumnNames(headerRow, table.width);

    const columnMetadataByIndex = new Map(
      tableMetadata.columns.map((column) => [column.columnIndex, column]),
    );

    const missingIndexes: number[] = [];

    for (let index = 0; index < table.width; index += 1) {
      if (!columnMetadataByIndex.has(index)) {
        missingIndexes.push(index);
      }
    }

    if (missingIndexes.length > 0) {
      throw new MergeError(
        `Metadata for table "${table.tableName}" is missing column index/indexes: ${missingIndexes.join(", ")}. Expected 0 to ${table.width - 1}.`,
      );
    }

    const rows: Record<string, unknown>[] = dataRows.map((row) => {
      const record: Record<string, unknown> = {};

      columnNames.forEach((columnName, index) => {
        const cell = row[index];

        record[columnName] = isEmptyCell(cell) ? null : cell;
      });

      return record;
    });

    totalDataRows += rows.length;

    // Sample values and emptiness are observed from the data rows only, so
    // header text can never leak into a column's samples.
    const columns = columnNames.map((columnName, index) => {
      const inferred = columnMetadataByIndex.get(index);

      if (!inferred) {
        throw new MergeError(
          `Metadata for table "${table.tableName}" is missing column index ${index}.`,
        );
      }

      const sampleValues: string[] = [];
      let hasEmptyValues = false;

      for (const row of rows) {
        const value = row[columnName];

        if (isEmptyCell(value)) {
          hasEmptyValues = true;
          continue;
        }

        const text = stringifyCell(value);

        if (sampleValues.length < 5 && !sampleValues.includes(text)) {
          sampleValues.push(text);
        }
      }

      return {
        name: columnName,
        inferredType: inferred.inferredType,
        // The parser observed empty cells directly, so that observation wins
        // over the model's guess when the parser saw one.
        nullable: hasEmptyValues ? true : inferred.nullable,
        sampleValues,
      };
    });

    return {
      tableName: table.tableName,
      tableRole: tableMetadata.tableRole,
      headerRowIndex,
      columns,
      rows,
      // Hashes the stored rows, so the hash always describes what was stored.
      rowHash: hashRows(rows),
    };
  });

  // Relationships naming a table or column that does not exist are discarded
  // rather than stored, since they would break any downstream join.
  const columnsByTable = new Map(
    tables.map((table) => [
      table.tableName,
      new Set(table.columns.map((column) => column.name)),
    ]),
  );

  const relationships = metadata.relationships.filter((relationship) => {
    const fromColumns = columnsByTable.get(relationship.fromTable);
    const toColumns = columnsByTable.get(relationship.toTable);

    return (
      fromColumns?.has(relationship.fromColumn) === true &&
      toColumns?.has(relationship.toColumn) === true
    );
  });

  const candidate = {
    datasetId,
    sourceFile,
    tables,
    relationships,
  };

  // Never store partially valid output.
  const result = normalizedDatasetSchema.safeParse(candidate);

  if (!result.success) {
    throw new MergeError(
      `Normalized dataset failed schema validation: ${JSON.stringify(result.error.issues)}`,
    );
  }

  return { dataset: result.data, totalDataRows };
};
