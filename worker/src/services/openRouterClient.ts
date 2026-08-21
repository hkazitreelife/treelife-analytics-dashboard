/**
 * Mirrors apps/web/lib/openRouterClient.ts exactly. Duplicated rather than
 * imported because worker and apps/web are separate packages in this
 * workspace, not because the logic is meant to differ. See that file's
 * doc comment for the full story: with an OpenRouter-format
 * ANTHROPIC_API_KEY, calling Anthropic's native SDK directly fails
 * outright, because OpenRouter's endpoint shape is not the same one the
 * SDK targets.
 */

export interface LlmCompletionRequest {
  apiKey: string;
  model: string;
  system: string;
  userPrompt: string;
  maxTokens?: number;
}

export interface LlmCompletionResponse {
  rawContent: string;
  jsonContent: any | null;
  inputTokens?: number;
  outputTokens?: number;
}

export async function callLlmCompletion(
  req: LlmCompletionRequest,
): Promise<LlmCompletionResponse> {
  const { apiKey, model, system, userPrompt, maxTokens = 8000 } = req;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model.includes("/") ? model : `anthropic/${model}`,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt },
      ],
      max_tokens: maxTokens,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter API error (status ${res.status}): ${errText}`);
  }

  const data: any = await res.json();
  const rawContent = data.choices?.[0]?.message?.content || "";

  let jsonContent: any = null;
  let clean = rawContent.trim();

  if (clean.includes("```")) {
    const match = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (match && match[1]) {
      clean = match[1].trim();
    } else {
      clean = clean.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    }
  }

  const firstBrace = clean.indexOf("{");
  const lastBrace = clean.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1) {
    clean = clean.slice(firstBrace, lastBrace + 1);
  }

  try {
    jsonContent = JSON.parse(clean);
  } catch (parseErr) {
    console.warn("[callLlmCompletion] Failed to parse JSON content:", parseErr, clean.slice(0, 200));
  }

  return {
    rawContent,
    jsonContent,
    inputTokens: data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
  };
}
