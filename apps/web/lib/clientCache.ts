const cache = new Map<string, { data: any; timestamp: number }>();
const inFlight = new Map<string, Promise<any>>();

const DEFAULT_TTL_MS = 120_000; // 2 minutes

export async function fetchJsonCached<T>(
  url: string,
  ttlMs = DEFAULT_TTL_MS,
  allowStale = true,
): Promise<T> {
  const now = Date.now();
  const existing = cache.get(url);

  // If fresh, return immediately
  if (existing && now - existing.timestamp < ttlMs) {
    return existing.data as T;
  }

  // If stale but allowed, return stale immediately and revalidate in background
  if (existing && allowStale) {
    if (!inFlight.has(url)) {
      const bgPromise = fetch(url, { credentials: "include" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data) cache.set(url, { data, timestamp: Date.now() });
        })
        .catch(() => {})
        .finally(() => inFlight.delete(url));
      inFlight.set(url, bgPromise);
    }
    return existing.data as T;
  }

  // Deduplicate simultaneous in-flight requests for the same URL
  if (inFlight.has(url)) {
    return inFlight.get(url) as Promise<T>;
  }

  const promise = (async () => {
    try {
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Request failed with status ${response.status}`);
      }
      const data = await response.json();
      cache.set(url, { data, timestamp: Date.now() });
      return data as T;
    } finally {
      inFlight.delete(url);
    }
  })();

  inFlight.set(url, promise);
  return promise;
}

export function invalidateClientCache(urlPattern?: string) {
  if (!urlPattern) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.includes(urlPattern)) {
      cache.delete(key);
    }
  }
}
