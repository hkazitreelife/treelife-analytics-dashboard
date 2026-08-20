// Cache service for Gemini metadata inference
import type { Payload } from "payload";
import type { GeminiMetadata } from "@analytics/shared";

/** Retrieve cached Gemini metadata for a given file hash. Returns null if not present. */
export async function getCachedGeminiMetadata(
  payload: Payload,
  hash: string,
): Promise<GeminiMetadata | null> {
  const result = await payload.find({
    collection: "geminiMetadataCache",
    where: { hash: { equals: hash } },
    limit: 1,
    depth: 0,
  });
  if (result && result.docs && result.docs.length > 0) {
    return (result.docs[0] as any).metadata as GeminiMetadata;
  }
  return null;
}

/** Store Gemini metadata in the cache keyed by file hash. */
export async function storeGeminiMetadata(
  payload: Payload,
  hash: string,
  metadata: GeminiMetadata,
): Promise<void> {
  await payload.create({
    collection: "geminiMetadataCache",
    data: { hash, metadata },
  });
}
