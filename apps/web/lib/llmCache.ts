import { createHash } from "node:crypto";

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
  storedAt: number;
};

const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_CACHE_ENTRIES = 500;

const cache = new Map<string, CacheEntry<unknown>>();

/**
 * Creates a deterministic SHA-256 hash key for an LLM prompt/config/context pair.
 */
export const computeLlmCacheKey = (
  model: string,
  promptOrMessages: unknown,
  contextOrConfig?: unknown,
): string => {
  const serialized = JSON.stringify({
    model,
    prompt: promptOrMessages,
    context: contextOrConfig ?? null,
  });

  return createHash("sha256").update(serialized).digest("hex");
};

/**
 * Retrieve cached response for an identical model + prompt + context pair.
 */
export const getCachedLlmResponse = <T>(key: string): T | undefined => {
  const entry = cache.get(key);

  if (!entry) {
    return undefined;
  }

  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }

  return entry.value as T;
};

/**
 * Store LLM response in cache.
 */
export const setCachedLlmResponse = <T>(
  key: string,
  value: T,
  ttlMs: number = DEFAULT_CACHE_TTL_MS,
): void => {
  // Evict oldest entries if capacity reached
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) {
      cache.delete(oldestKey);
    }
  }

  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
    storedAt: Date.now(),
  });
};

/**
 * Invalidate all or pattern-matching cache entries.
 */
export const clearLlmCache = (pattern?: string): void => {
  if (!pattern) {
    cache.clear();
    return;
  }

  for (const key of cache.keys()) {
    if (key.includes(pattern)) {
      cache.delete(key);
    }
  }
};

export type TokenUsageMetadata = {
  action: string;
  model: string;
  sessionId?: string | number | null;
  datasetId?: string | number | null;
  documentId?: string | number | null;
  inputTokens?: number;
  outputTokens?: number;
  cached?: boolean;
};

/**
 * Structured token usage logger for production observability & cost tracking.
 */
export const logTokenUsage = (meta: TokenUsageMetadata): void => {
  const inTokens = meta.inputTokens ?? 0;
  const outTokens = meta.outputTokens ?? 0;
  const total = inTokens + outTokens;

  const logPayload = {
    event: "llm_token_usage",
    action: meta.action,
    model: meta.model,
    sessionId: meta.sessionId ? String(meta.sessionId) : undefined,
    datasetId: meta.datasetId ? String(meta.datasetId) : undefined,
    documentId: meta.documentId ? String(meta.documentId) : undefined,
    inputTokens: inTokens,
    outputTokens: outTokens,
    totalTokens: total,
    cached: Boolean(meta.cached),
    timestamp: new Date().toISOString(),
  };

  console.info(
    `[TOKEN_USAGE] action=${meta.action} model=${meta.model} session=${meta.sessionId ?? "n/a"} in=${inTokens} out=${outTokens} total=${total} cached=${Boolean(meta.cached)}`,
    JSON.stringify(logPayload),
  );
};
