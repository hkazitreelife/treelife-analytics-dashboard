import { requireUser } from "@/lib/auth";
import { runChatQuestion } from "@/lib/chat";
import { createChatClient } from "@/lib/claudeChatClient";

export const runtime = "nodejs";

const requireEnv = (name: string): string => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }

  return value;
};

/**
 * Section 20.9 / 17. Read-only, dataset-scoped chat. `id` (the URL param)
 * is the only dataset identifier this route ever reads; the request body's
 * `message` is passed through as opaque text for Claude to answer from the
 * context lib/chat.ts builds, never interpreted as a request to fetch data.
 * See lib/chat.ts's doc comment for exactly how scope is enforced.
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
    chatClient = createChatClient(requireEnv("ANTHROPIC_API_KEY"));
  } catch (error: unknown) {
    payload.logger.error({ err: error }, "Could not construct chat client.");

    return Response.json(
      { error: "Server is not configured to run chat." },
      { status: 500 },
    );
  }

  const result = await runChatQuestion(id, message, { payload, chatClient });

  if (!result.ok) {
    payload.logger.warn(`Chat for dataset ${id} failed: ${result.error}`);

    return Response.json({ error: result.error }, { status: result.status });
  }

  return Response.json({
    answer: result.answer,
    sources: result.sources,
    datasetId: result.datasetId,
  });
}
