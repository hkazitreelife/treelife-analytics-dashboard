type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const memoryCache = new Map<string, CacheEntry<unknown>>();

export const getCache = <T>(key: string): T | undefined => {
  const entry = memoryCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    memoryCache.delete(key);
    return undefined;
  }
  return entry.value as T;
};

export const setCache = <T>(key: string, value: T, ttlMs: number = 60_000): void => {
  memoryCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
};

export const invalidateCache = (pattern?: string): void => {
  if (!pattern) {
    memoryCache.clear();
    return;
  }
  for (const key of memoryCache.keys()) {
    if (key.includes(pattern)) {
      memoryCache.delete(key);
    }
  }
};
