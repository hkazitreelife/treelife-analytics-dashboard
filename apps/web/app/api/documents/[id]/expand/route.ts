import { requireUser } from "@/lib/auth";
import { createClaudeDocumentExpandClient } from "@/lib/claudeDocumentExpandClient";
import { runDocumentExpand } from "@/lib/documentExpand";

export const runtime = "nodejs";

const requireEnv = (name: string): string => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }

  return value;
};

/**
 * Section 10.0 Step 4: POST /api/documents/:id/expand, body
 * {afterPointId?: string, focusSectionId?: string}. Reuses the document's
 * already-stored fullText/sections -- no re-extraction, no Gemini call here
 * at all.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser(request);

  if (!auth.authenticated) {
    return auth.response;
  }

  const { payload, user } = auth;
  const { id } = await context.params;

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    // An empty body is valid (both fields are optional).
    body = {};
  }

  const record =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};

  const afterPointId =
    typeof record.afterPointId === "string" ? record.afterPointId : undefined;
  const focusSectionId =
    typeof record.focusSectionId === "string" ? record.focusSectionId : undefined;

  let expandClient;

  try {
    expandClient = createClaudeDocumentExpandClient(requireEnv("ANTHROPIC_API_KEY"));
  } catch (error: unknown) {
    payload.logger.error({ err: error }, "Could not construct document expand client.");

    return Response.json(
      { error: "Server is not configured to run document expand." },
      { status: 500 },
    );
  }

  const result = await runDocumentExpand(id, afterPointId, focusSectionId, user.id, {
    payload,
    expandClient,
  });

  if (!result.ok) {
    payload.logger.warn(`Expand for document ${id} failed: ${result.error}`);

    return Response.json({ error: result.error }, { status: result.status });
  }

  return Response.json({
    documentId: result.documentId,
    summaryVersion: result.summaryVersion,
    newKeyPoints: result.newKeyPoints,
  });
}
