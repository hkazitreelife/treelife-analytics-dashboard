import { requireUser } from "@/lib/auth";
import { createDocumentChatClient } from "@/lib/claudeDocumentChatClient";
import { runDocumentChatQuestion } from "@/lib/documentChat";

export const runtime = "nodejs";

const requireEnv = (name: string): string => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }

  return value;
};

/**
 * Section 10.2. Read-only, document-scoped chat -- same shape as
 * POST /api/datasets/:id/chat. `id` (the URL param) is the only document
 * identifier this route ever reads; the request body's `message` is opaque
 * text for Claude to answer from the context lib/documentChat.ts builds.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await requireUser(request);

  if (!auth.authenticated) {
    return auth.response;
  }

  const { payload } = auth;
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
    !("message" in body) ||
    typeof (body as { message: unknown }).message !== "string"
  ) {
    return Response.json(
      { error: 'Request body must be { "message": "string" }.' },
      { status: 400 },
    );
  }

  const { message } = body as { message: string };

  let chatClient;

  try {
    chatClient = createDocumentChatClient(requireEnv("ANTHROPIC_API_KEY"));
  } catch (error: unknown) {
    payload.logger.error({ err: error }, "Could not construct document chat client.");

    return Response.json(
      { error: "Server is not configured to run document chat." },
      { status: 500 },
    );
  }

  const result = await runDocumentChatQuestion(id, message, { payload, chatClient });

  if (!result.ok) {
    payload.logger.warn(`Chat for document ${id} failed: ${result.error}`);

    return Response.json({ error: result.error }, { status: result.status });
  }

  return Response.json({
    directAnswer: result.directAnswer,
    citations: result.citations,
    caveats: result.caveats,
    documentId: result.documentId,
  });
}
