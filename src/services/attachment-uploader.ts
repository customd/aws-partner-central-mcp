import { promises as fs } from "node:fs";
import path from "node:path";

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

import {
  ATTACHMENT_ALLOWED_EXTENSIONS,
  ATTACHMENT_DOC_SIZE_LIMIT,
  ATTACHMENT_IMAGE_EXTENSIONS,
  ATTACHMENT_IMAGE_SIZE_LIMIT,
  ATTACHMENT_S3_BUCKET,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "../constants.js";
import { logger } from "../logger.js";
import type { AwsCredentials, DocumentContentBlock } from "../types.js";

export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentError";
  }
}

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  txt: "text/plain",
};

function extensionOf(filePath: string): string {
  return path.extname(filePath).replace(/^\./, "").toLowerCase();
}

function isImageExtension(ext: string): boolean {
  return (ATTACHMENT_IMAGE_EXTENSIONS as readonly string[]).includes(ext);
}

function humanSize(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

/**
 * Validate a set of attachment paths up-front (count + extension) before any
 * network or filesystem work, so the agent gets fast, actionable feedback.
 * Per-file size is validated at upload time once the file is stat'd.
 */
export function validateAttachmentPaths(filePaths: readonly string[]): void {
  if (filePaths.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new AttachmentError(
      `Too many attachments: ${filePaths.length}. The Partner Central agent accepts at most ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`,
    );
  }
  for (const filePath of filePaths) {
    const ext = extensionOf(filePath);
    if (!(ATTACHMENT_ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new AttachmentError(
        `Unsupported attachment type '${ext || "(none)"}' for '${path.basename(
          filePath,
        )}'. Allowed: ${ATTACHMENT_ALLOWED_EXTENSIONS.join(", ")}.`,
      );
    }
  }
}

interface UploadParams {
  credentials: AwsCredentials;
  region: string;
  accountId: string;
  filePath: string;
}

/**
 * Upload a single local file to the AWS-managed ephemeral S3 bucket under the
 * caller's account-ID prefix and return a `document` content block whose
 * `s3Uri` includes the required `versionId`.
 *
 * The bucket is write-only and account-scoped; AWS retains uploads only
 * transiently for agent analysis.
 */
export async function uploadDocument(
  params: UploadParams,
): Promise<DocumentContentBlock> {
  const { credentials, region, accountId, filePath } = params;
  const resolved = path.resolve(filePath);
  const filename = path.basename(resolved);
  const ext = extensionOf(resolved);

  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    throw new AttachmentError(
      `Attachment not found: '${filePath}'. Provide an absolute path to a local file.`,
    );
  }
  if (!stat.isFile()) {
    throw new AttachmentError(`Attachment is not a regular file: '${filePath}'.`);
  }

  const limit = isImageExtension(ext)
    ? ATTACHMENT_IMAGE_SIZE_LIMIT
    : ATTACHMENT_DOC_SIZE_LIMIT;
  if (stat.size > limit) {
    throw new AttachmentError(
      `Attachment '${filename}' is ${humanSize(stat.size)}, exceeding the ${humanSize(
        limit,
      )} limit for ${isImageExtension(ext) ? "images" : "documents"}.`,
    );
  }

  const body = await fs.readFile(resolved);
  const key = `${accountId}/${filename}`;

  const s3 = new S3Client({
    region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
  });

  logger.debug("Uploading attachment to ephemeral S3 bucket", {
    bucket: ATTACHMENT_S3_BUCKET,
    key,
    bytes: stat.size,
  });

  let versionId: string | undefined;
  try {
    const resp = await s3.send(
      new PutObjectCommand({
        Bucket: ATTACHMENT_S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: CONTENT_TYPES[ext] ?? "application/octet-stream",
      }),
    );
    versionId = resp.VersionId;
  } catch (err) {
    throw new AttachmentError(
      `Failed to upload '${filename}' to the Partner Central document bucket: ${
        (err as Error).message
      }. Confirm your AWS role is permitted to write to s3://${ATTACHMENT_S3_BUCKET}/${accountId}/.`,
    );
  } finally {
    s3.destroy();
  }

  if (!versionId) {
    throw new AttachmentError(
      `Upload of '${filename}' did not return an S3 versionId. The Partner Central agent requires a versioned object reference; the upload cannot be used.`,
    );
  }

  const s3Uri = `s3://${ATTACHMENT_S3_BUCKET}/${key}?versionId=${versionId}`;
  return { type: "document", filename, s3Uri };
}
