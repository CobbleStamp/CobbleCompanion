/**
 * The real `@aws-sdk` implementation of {@link S3Operations}. Isolated in its own
 * module so the store and its tests never load the SDK. Credentials and region
 * come from the injected `S3Client` (the default provider chain on EC2 — the
 * instance role — in production).
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { S3Operations } from './upload-staging-s3.js';

export class AwsS3Operations implements S3Operations {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  presignPut(
    key: string,
    opts: { readonly contentType?: string; readonly expiresInSec: number },
  ): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(opts.contentType ? { ContentType: opts.contentType } : {}),
    });
    return getSignedUrl(this.client, command, { expiresIn: opts.expiresInSec });
  }

  async put(
    key: string,
    bytes: Uint8Array,
    opts?: { readonly contentType?: string },
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ...(opts?.contentType ? { ContentType: opts.contentType } : {}),
      }),
    );
  }

  async head(key: string): Promise<{ byteSize: number } | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return { byteSize: response.ContentLength ?? 0 };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  async getRange(key: string, n: number): Promise<Uint8Array | null> {
    return this.getBody(key, `bytes=0-${n - 1}`);
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.getBody(key);
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  private async getBody(key: string, range?: string): Promise<Uint8Array | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ...(range ? { Range: range } : {}),
        }),
      );
      if (!response.Body) {
        return new Uint8Array(0);
      }
      return await response.Body.transformToByteArray();
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }
}

/** Build the AWS-backed S3 operations, constructing the client from the region. */
export function createAwsS3Operations(opts: {
  readonly region: string;
  readonly bucket: string;
}): S3Operations {
  return new AwsS3Operations(new S3Client({ region: opts.region }), opts.bucket);
}

/** S3 signals a missing key with NoSuchKey/NotFound or a 404 on the response. */
function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const name = (error as { name?: string }).name;
  if (name === 'NoSuchKey' || name === 'NotFound') {
    return true;
  }
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return status === 404;
}
