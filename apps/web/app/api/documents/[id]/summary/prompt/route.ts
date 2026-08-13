import { requireUser } from "@/lib/auth";
import { createClaudeDocumentEditClient } from "@/lib/claudeDocumentEditClient";
import { runDocumentPromptEdit } from "@/lib/documentPromptEdit";

export const runtime = "nodejs";

const requireEnv = (name: string): string => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }

  return value;
};

/**
 * Section 10.2 Step 3: POST /api/documents/:id/summary/prompt, mirroring
 * POST /api/datasets/:id/config/prompt's shape. Reshapes/filters the
 * existing keyPoints list -- distinct from POST /api/documents/:id/expand
 * (Section 10.0 Step 4), which only ever adds.
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
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !("prompt" in body) ||
    typeof (body as { prompt: unknown }).prompt !== "string"
  ) {
    return Response.json(
      { error: 'Request body must be { "prompt": "string" }.' },
      { status: 400 },
    );
  }

  const { prompt } = body as { prompt: string };

  let editClient;

  try {
    editClient = createClaudeDocumentEditClient(requireEnv("ANTHROPIC_API_KEY"));
  } catch (error: unknown) {
    payload.logger.error({ err: error }, "Could not construct document edit client.");

    return Response.json(
      { error: "Server is not configured to run document prompt edits." },
      { status: 500 },
    );
  }

  const result = await runDocumentPromptEdit(id, prompt, user.id, {
    payload,
    editClient,
  });

  if (!result.ok) {
    payload.logger.warn(`Prompt edit for document ${id} failed: ${result.error}`);

    return Response.json({ error: result.error }, { status: result.status });
  }

  return Response.json({
    documentId: result.documentId,
    summaryVersion: result.summaryVersion,
    status: "updated",
  });
}
