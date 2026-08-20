import { fileTypeFromFilename } from "@/lib/fileType";
import { requireUser } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireUser(request);

  if (!auth.authenticated) {
    return auth.response;
  }

  const { payload } = auth;
  const url = new URL(request.url);
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);

  try {
    const result = await payload.find({
      collection: "datasets",
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50,
      // depth: 1 so currentFile populates with its filename, for fileType.
      depth: 1,
      sort: "-updatedAt",
    });

    return Response.json({
      totalDocs: result.totalDocs,
      datasets: result.docs.map((dataset) => ({
        id: String(dataset.id),
        name: dataset.name,
        status: dataset.status,
        totalRows: dataset.totalRows ?? 0,
        tableNames: (dataset.tableNames ?? []).map((entry) => entry.tableName),
        // Prompt 12.0: the sidebar's type badge (xlsx/csv/...).
        fileType: fileTypeFromFilename(
          typeof dataset.currentFile === "object" && dataset.currentFile
            ? dataset.currentFile.filename
            : null,
        ),
        createdAt: dataset.createdAt,
        updatedAt: dataset.updatedAt,
      })),
    });
  } catch (error: unknown) {
    payload.logger.error({ err: error }, "Failed to list datasets.");

    return Response.json(
      { error: "Failed to list datasets." },
      { status: 500 },
    );
  }
}
