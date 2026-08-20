import { requireUser } from "@/lib/auth";
import { createChatClient } from "@/lib/claudeChatClient";
import { createDocumentChatClient } from "@/lib/claudeDocumentChatClient";
import { createSessionChatClient } from "@/lib/claudeSessionChatClient";
import { runSessionChat } from "@/lib/sessionChat";

export const runtime = "nodejs";

const requireEnv = (name: string): string => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }

  return value;
};

/**
 * Prompt 15.0 Part 2 item 4. The one universal chat endpoint every session
 * uses, single-source or multi-source. Which underlying client actually
 * gets called is decided inside lib/sessionChat.ts based on how many
 * sources the session has -- this route just wires all three possible
 * clients and hands off.
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
    !("message" in body) ||
    typeof (body as { message: unknown }).message !== "string"
  ) {
    return Response.json(
      { error: 'Request body must be { "message": "string" }.' },
      { status: 400 },
    );
  }

  const { message } = body as { message: string };

  let apiKey: string;

  try {
    apiKey = requireEnv("ANTHROPIC_API_KEY");
  } catch (error: unknown) {
    payload.logger.error({ err: error }, "Could not construct session chat clients.");

    return Response.json(
      { error: "Server is not configured to run session chat." },
      { status: 500 },
    );
  }

  const result = await runSessionChat(id, message, {
    payload,
    chatClient: createChatClient(apiKey),
    documentChatClient: createDocumentChatClient(apiKey),
    sessionChatClient: createSessionChatClient(apiKey),
    userId: user.id,
  });

  if (!result.ok) {
    payload.logger.warn(`Session chat for session ${id} failed: ${result.error}`);

    return Response.json({ error: result.error }, { status: result.status });
  }

  return Response.json({ sessionId: result.sessionId, ...result.answer });
}
