import type { SupportedFileType } from "@analytics/shared";

/**
 * The pure, browser-safe half of upload file-type validation: no
 * node:crypto, no node:path, safe to import from a "use client" component.
 * lib/uploads.ts (server-only: sha256 hashing, the env-based size limit,
 * MIME+extension agreement) imports the extension table from here rather
 * than keeping its own copy, so there is exactly one list of supported
 * extensions, not two that could drift.
 */

export const EXTENSION_TO_TYPE: Record<string, SupportedFileType> = {
  ".xlsx": "xlsx",
  ".csv": "csv",
  ".pdf": "pdf",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".pptx": "pptx",
  // Section 10.0: routed to the narrative-document pipeline, never Section
  // 14's table path.
  ".docx": "docx",
};

export const supportedExtensions = (): string[] =>
  Object.keys(EXTENSION_TO_TYPE);

const extensionOf = (filename: string): string => {
  const dot = filename.lastIndexOf(".");

  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
};

/**
 * Client-side pre-check only: whether the extension is even one the upload
 * route would consider. A browser's Content-Type guess is not authoritative
 * the way it is once the server reads the real bytes, so this deliberately
 * does not replicate the server's full MIME+extension agreement check
 * (resolveFileType in lib/uploads.ts) -- a file that passes this can still
 * be rejected server-side, and that's expected. This exists only to reject
 * an obviously-wrong file before spending an upload attempt on it.
 */
export const hasSupportedExtension = (filename: string): boolean =>
  extensionOf(filename) in EXTENSION_TO_TYPE;
