import { requireUser } from "@/lib/auth";
import { createClaudeConfigEditClient } from "@/lib/claudeConfigEditClient";
import { createClaudeDocumentEditClient } from "@/lib/claudeDocumentEditClient";
import { createClaudeCombinedDashboardClient } from "@/lib/claudeCombinedDashboardClient";
import { createSessionEditTargetClient } from "@/lib/claudeSessionEditTargetClient";
import { publishDatasetEvent } from "@/lib/events";
import { runSessionEdit } from "@/lib/sessionEdit";

export const runtime = "nodejs";

const requireEnv = (name: string): string => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }

  return value;
};

/**
 * Prompt 15.0 Part 2 item 4. The one universal edit endpoint every session
 * uses. Single-source sessions delegate straight through to the existing
 * dataset/document edit logic; multi-source sessions resolve a target
 * first (lib/sessionEdit.ts) and may return `needs_clarification` instead
 * of applying anything.
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

  let apiKey: string;

  try {
    apiKey = requireEnv("ANTHROPIC_API_KEY");
  } catch (error: unknown) {
    payload.logger.error({ err: error }, "Could not construct session edit clients.");

    return Response.json(
      { error: "Server is not configured to run session edits." },
      { status: 500 },
    );
  }

  const result = await runSessionEdit(id, prompt, {
    payload,
    editClient: createClaudeConfigEditClient(apiKey),
    documentEditClient: createClaudeDocumentEditClient(apiKey),
    combinedDashboardClient: createClaudeCombinedDashboardClient(apiKey),
    targetClient: createSessionEditTargetClient(apiKey),
    publishEvent: publishDatasetEvent,
    userId: user.id,
  });

  if (!result.ok) {
    payload.logger.warn(`Session edit for session ${id} failed: ${result.error}`);

    return Response.json({ error: result.error }, { status: result.status });
  }

  if (result.kind === "needs_clarification") {
    return Response.json({
      sessionId: result.sessionId,
      status: "needs_clarification",
      question: result.question,
    });
  }

  return Response.json({
    sessionId: result.sessionId,
    status: "applied",
    targetKind: result.targetKind,
    version: result.version,
  });
}
