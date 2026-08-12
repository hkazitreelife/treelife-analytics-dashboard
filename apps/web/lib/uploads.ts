import { createHash } from "node:crypto";
import path from "node:path";

import type { SupportedFileType } from "@analytics/shared";

import { EXTENSION_TO_TYPE, supportedExtensions } from "./uploadValidation";

export { supportedExtensions };

/**
 * MIME type to normalized file type. Nothing here describes any particular
 * dataset; it only decides which formats the parser is allowed to accept.
 * The extension table lives in uploadValidation.ts (browser-safe, no
 * node:crypto/node:path) so the client-side pre-check and this server-side
 * check never disagree about which extensions exist.
 */
const MIME_TO_TYPE: Record<string, SupportedFileType> = {
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/csv": "csv",
  "application/csv": "csv",
  "application/pdf": "pdf",
  "image/png": "image",
  "image/jpeg": "image",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
};

export const readPositiveIntEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];

  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const maxUploadBytes = (): number =>
  readPositiveIntEnv("UPLOAD_MAX_SIZE_MB", 25) * 1024 * 1024;

export const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

export const baseNameWithoutExtension = (filename: string): string =>
  path.basename(filename, path.extname(filename));

/**
 * Both the MIME type and the extension must map to the same supported type.
 * A mismatch is rejected rather than guessed at.
 */
export const resolveFileType = (
  filename: string,
  mimeType: string,
): SupportedFileType | null => {
  const byMime = MIME_TO_TYPE[mimeType.toLowerCase()];
  const byExtension = EXTENSION_TO_TYPE[path.extname(filename).toLowerCase()];

  if (!byMime || !byExtension || byMime !== byExtension) {
    return null;
  }

  return byMime;
};
