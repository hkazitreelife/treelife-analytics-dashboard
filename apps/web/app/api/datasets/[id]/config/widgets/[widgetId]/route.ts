import { z } from "zod";

import { requireUser } from "@/lib/auth";
import { publishDatasetEvent } from "@/lib/events";
import { runDirectWidgetEdit } from "@/lib/directWidgetEdit";

export const runtime = "nodejs";

/**
 * Prompt 16.0 item 9: the fast, deterministic sibling of
 * /api/datasets/[id]/config/prompt (the LLM edit path). No AI call, no
 * ANTHROPIC_API_KEY dependency, no billing/validation-retry error classes
 * to translate -- runDirectWidgetEdit either applies a real, checked
 * change or returns one plain error, matching how a UI control (a chart
 * type dropdown, a field picker) should feel: immediate, not a network
 * round trip to a model that might say no for reasons unrelated to what
 * was actually asked.
 */
const editSchema = z
  .object({
    type: z.string().min(1).optional(),
    fields: z.array(z.string().min(1)).min(1).optional(),
    aggregation: z.string().min(1).optional(),
    position: z
      .object({
        row: z.number().int().min(0),
        col: z.number().int().min(0),
        w: z.number().int().min(1),
        h: z.number().int().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; widgetId: string }> },
): Promise<Response> {
  const auth = await requireUser(request);

  if (!auth.authenticated) {
    return auth.response;
  }

  const { payload } = auth;
  const { id, widgetId } = await context.params;

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const parsed = editSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      {
        error:
          'Request body must be { "type"?, "fields"?, "aggregation"?, "position"? } -- at least one field, matching an existing widget exactly.',
        detail: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  const result = await runDirectWidgetEdit(id, widgetId, parsed.data, {
    payload,
    publishEvent: publishDatasetEvent,
  });

  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status });
  }

  return Response.json({
    datasetId: result.datasetId,
    configVersion: result.configVersion,
    status: "updated",
  });
}
