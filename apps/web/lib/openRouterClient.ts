/**
 * Universal OpenRouter / Anthropic caller for Chat, Edit, and Ingestion.
 * Seamlessly handles OpenRouter API keys (sk-or-v1-...) via OpenAI-compatible
 * chat completions and Anthropic API keys (sk-ant-...) via Anthropic SDK.
 */

export interface LlmCompletionRequest {
  apiKey: string;
  model: string;
  system: string;
  userPrompt: string;
  maxTokens?: number;
  responseFormatJson?: boolean;
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
  const { apiKey, model, system, userPrompt, maxTokens = 4000, responseFormatJson = true } = req;

  // 1. Direct OpenRouter / OpenAI-compatible endpoint
  if (apiKey.startsWith("sk-or-") || process.env.ANTHROPIC_BASE_URL?.includes("openrouter")) {
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

    const data = await res.json();
    const rawContent = data.choices?.[0]?.message?.content || "";

    let jsonContent: any = null;
    if (responseFormatJson) {
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
    }

    return {
      rawContent,
      jsonContent,
      inputTokens: data.usage?.prompt_tokens,
      outputTokens: data.usage?.completion_tokens,
    };
  }

  // 2. Direct Anthropic SDK
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userPrompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const rawContent = textBlock ? textBlock.text : "";

  let jsonContent: any = null;
  if (responseFormatJson) {
    let clean = rawContent.trim();
    if (clean.includes("```")) {
      const match = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (match && match[1]) {
        clean = match[1].trim();
      }
    }
    const firstBrace = clean.indexOf("{");
    const lastBrace = clean.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1) {
      clean = clean.slice(firstBrace, lastBrace + 1);
    }
    try {
      jsonContent = JSON.parse(clean);
    } catch {
      // Ignored
    }
  }

  return {
    rawContent,
    jsonContent,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}
