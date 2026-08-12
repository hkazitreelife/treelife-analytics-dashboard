import { requireUser } from "@/lib/auth";
import { createClaudeConfigEditClient } from "@/lib/claudeConfigEditClient";
import { publishDatasetEvent } from "@/lib/events";
import { runPromptEdit } from "@/lib/promptEdit";

export const runtime = "nodejs";

const requireEnv = (name: string): string => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }

  return value;
};

/**
 * Section 20.8 / 13.3. Prompt-based dashboard editing. Runs synchronously in
 * the web process -- unlike ingestion, this is not a BullMQ job, since
 * Section 13.3 describes a direct request/response flow with no polling.
 * The actual editing logic lives in lib/promptEdit.ts so it can be tested
 * with a stubbed Claude client; this route only wires real dependencies and
 * translates the result to HTTP.
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
    editClient = createClaudeConfigEditClient(requireEnv("ANTHROPIC_API_KEY"));
  } catch (error: unknown) {
    payload.logger.error({ err: error }, "Could not construct Claude edit client.");

    return Response.json(
      { error: "Server is not configured to run prompt edits." },
      { status: 500 },
    );
  }

  const result = await runPromptEdit(id, prompt, user.id, {
    payload,
    editClient,
    publishEvent: publishDatasetEvent,
  });

  if (!result.ok) {
    payload.logger.warn(`Prompt edit for dataset ${id} failed: ${result.error}`);

    return Response.json({ error: result.error }, { status: result.status });
  }

  return Response.json({
    datasetId: result.datasetId,
    configVersion: result.configVersion,
    status: "updated",
  });
}
