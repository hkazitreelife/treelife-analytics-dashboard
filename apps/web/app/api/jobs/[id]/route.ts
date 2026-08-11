import { requireUser } from "@/lib/auth";

export const runtime = "nodejs";

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

  try {
    const job = await payload.findByID({
      collection: "jobs",
      id,
      depth: 0,
    });

    return Response.json({
      id: String(job.id),
      status: job.status,
      error: job.error ?? null,
      datasetId: job.dataset === null || job.dataset === undefined
        ? null
        : String(job.dataset),
      updatedAt: job.updatedAt,
      completedAt: job.completedAt ?? null,
      retryCount: job.retryCount,
    });
  } catch {
    return Response.json({ error: "Job not found." }, { status: 404 });
  }
}
