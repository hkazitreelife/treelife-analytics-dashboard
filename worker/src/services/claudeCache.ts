// Cache service for Claude dashboard config generation
import type { Payload } from "payload";
import type { ResolvedDashboardConfigShape } from "../../../packages/shared/src/schemas/dashboardConfig";

/** Retrieve cached Claude config for a given file hash. Returns null if absent. */
export async function getCachedClaudeConfig(
  payload: Payload,
  hash: string,
): Promise<ResolvedDashboardConfigShape | null> {
  const result = await payload.find({
    collection: "claudeConfigCache",
    where: { hash: { equals: hash } },
    limit: 1,
    depth: 0,
  });
  if (result && result.docs && result.docs.length > 0) {
    return (result.docs[0] as any).config as ResolvedDashboardConfigShape;
  }
  return null;
}

/** Store Claude config in the cache keyed by file hash. */
export async function storeClaudeConfig(
  payload: Payload,
  hash: string,
  config: ResolvedDashboardConfigShape,
): Promise<void> {
  await payload.create({
    collection: "claudeConfigCache",
    data: { hash, config },
  });
}
