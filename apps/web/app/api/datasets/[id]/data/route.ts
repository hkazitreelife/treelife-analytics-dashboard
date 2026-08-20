import { readIngestionLimits } from "@analytics/shared";

import { requireUser } from "@/lib/auth";
import { getCache, setCache } from "@/lib/cache";

export const runtime = "nodejs";

/** Section 23.3: tables should not render more than 100 rows unless paginated. */
const DEFAULT_LIMIT = 100;

// The renderer's chart-aggregation fetch (DashboardRenderer.tsx) needs up to
// one full table's worth of rows to compute a correct sum/avg/count, so the
// cap here must reach the ingestion-time per-table row limit, not an
// arbitrarily smaller number. A table can never have stored more rows than
// that limit, so this is "at most everything", never a true unbounded fetch.
const MAX_LIMIT = readIngestionLimits().maxRowsPerTable;

const pendingDatasetQueries = new Map<string, Promise<any>>();

type StoredTable = {
  tableName: string;
  tableRole: string;
  columns: { name: string; inferredType: string }[];
  rows: Record<string, unknown>[];
};

const readInt = (raw: string | null, fallback: number): number => {
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

/**
 * Section 20.6. Serves rows from the Dataset's stored normalized data. When no
 * table is named, the first table is returned along with every table name, so
 * the client can discover the shape without a second request.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser(request);

  if (!auth.authenticated) {
    return auth.response;
  }

  const { payload } = auth;
  const { id } = await context.params;
  const url = new URL(request.url);

  const requestedTable = url.searchParams.get("table");
  const limit = Math.min(readInt(url.searchParams.get("limit"), DEFAULT_LIMIT), MAX_LIMIT);
  const offset = readInt(url.searchParams.get("offset"), 0);

  const cacheKey = `dataset_data_${id}_${requestedTable || "first"}_${limit}_${offset}`;
  const cached = getCache<Record<string, unknown>>(cacheKey);
  if (cached) {
    return Response.json(cached);
  }

  try {
    const datasetCacheKey = `dataset_record_${id}`;
    let cachedDataset = getCache<{ status: string; tables: StoredTable[] }>(datasetCacheKey);

    if (!cachedDataset) {
      let datasetPromise = pendingDatasetQueries.get(id);
      if (!datasetPromise) {
        datasetPromise = payload.findByID({
          collection: "datasets",
          id,
          depth: 0,
        }).finally(() => {
          pendingDatasetQueries.delete(id);
        });
        pendingDatasetQueries.set(id, datasetPromise);
      }

      const dataset = await datasetPromise;
      const stored = dataset.data as { tables?: StoredTable[] } | null;
      cachedDataset = {
        status: dataset.status,
        tables: stored?.tables ?? [],
      };
      setCache(datasetCacheKey, cachedDataset, 120_000);
    }

    const { status, tables } = cachedDataset;

    if (tables.length === 0) {
      return Response.json(
        {
          datasetId: id,
          status,
          error:
            status === "failed"
              ? "This dataset failed to parse. No data is stored."
              : "This dataset has no stored tables yet.",
          availableTables: [],
        },
        { status: 409 },
      );
    }

    const table = requestedTable
      ? tables.find((candidate) => candidate.tableName === requestedTable)
      : tables[0];

    if (!table) {
      return Response.json(
        {
          error: `Table "${requestedTable}" does not exist in this dataset.`,
          availableTables: tables.map((candidate) => candidate.tableName),
        },
        { status: 404 },
      );
    }

    const rows = table.rows.slice(offset, offset + limit);

    const body = {
      datasetId: id,
      table: table.tableName,
      tableRole: table.tableRole,
      columns: table.columns.map((column) => ({
        name: column.name,
        inferredType: column.inferredType,
      })),
      rows,
      totalRows: table.rows.length,
      limit,
      offset,
      // Always present, so one request is enough to discover the dataset shape.
      availableTables: tables.map((candidate) => ({
        tableName: candidate.tableName,
        tableRole: candidate.tableRole,
        rowCount: candidate.rows.length,
      })),
    };

    setCache(cacheKey, body, 60_000);

    return Response.json(body);
  } catch (error: unknown) {
    payload.logger.error({ err: error }, "Failed to load dataset data.");

    return Response.json(
      { error: "Dataset not found or unreadable." },
      { status: 404 },
    );
  }
}
