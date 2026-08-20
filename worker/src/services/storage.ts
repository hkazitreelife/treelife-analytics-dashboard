import fs from "fs";
import path from "path";
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";

/**
 * Initializes S3 client with support for AWS S3, Cloudflare R2, and local S3 emulators.
 */
export const getS3Client = (): S3Client | null => {
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;

  if (!bucket || !accessKeyId || !secretAccessKey) {
    return null;
  }

  return new S3Client({
    region: process.env.S3_REGION || "auto",
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
    ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  });
};

/**
 * Downloads a file buffer from S3/R2 storage, or falls back to local media directory.
 */
export const downloadFileBuffer = async (
  fileKeyOrFilename: string,
): Promise<{ buffer: Buffer; contentType?: string; size: number }> => {
  const s3 = getS3Client();
  const bucket = process.env.S3_BUCKET;
  const prefix = process.env.S3_PREFIX || "media";

  if (s3 && bucket) {
    const s3Key = fileKeyOrFilename.startsWith(prefix)
      ? fileKeyOrFilename
      : `${prefix}/${fileKeyOrFilename}`;

    try {
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: s3Key,
      });

      const response = await s3.send(command);

      if (!response.Body) {
        throw new Error(`S3 object "${s3Key}" returned empty body.`);
      }

      const streamToBuffer = async (stream: any): Promise<Buffer> => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of stream) {
          chunks.push(chunk);
        }
        return Buffer.concat(chunks);
      };

      const buffer = await streamToBuffer(response.Body);

      return {
        buffer,
        contentType: response.ContentType,
        size: response.ContentLength || buffer.length,
      };
    } catch (err: unknown) {
      console.warn(
        `[Storage] S3 download failed for key "${s3Key}", checking local media fallback:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Local filesystem fallback (useful in local dev / non-S3 setups)
  const candidatePaths = [
    path.resolve(process.cwd(), "apps/web/media", fileKeyOrFilename),
    path.resolve(process.cwd(), "../apps/web/media", fileKeyOrFilename),
    path.resolve(process.cwd(), "media", fileKeyOrFilename),
    path.resolve(fileKeyOrFilename),
  ];

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      const buffer = fs.readFileSync(p);
      return {
        buffer,
        contentType: "application/octet-stream",
        size: buffer.length,
      };
    }
  }

  throw new Error(
    `File "${fileKeyOrFilename}" could not be found in S3 bucket or local media directories.`,
  );
};
