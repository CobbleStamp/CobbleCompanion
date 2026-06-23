/**
 * Build the configured upload-staging store (staging-object-storage.md §5). The
 * backend is chosen by `UPLOAD_STAGING_BACKEND`: S3 in production, a filesystem
 * root for local/CI. The AWS SDK stays inside `@cobble/core` — this only picks an
 * implementation from validated config.
 */

import {
  FilesystemUploadStagingStore,
  S3UploadStagingStore,
  createAwsS3Operations,
  type UploadStagingStore,
} from '@cobble/core';
import type { UploadStagingConfig } from './config.js';

export function createUploadStagingStore(config: UploadStagingConfig): UploadStagingStore {
  if (config.backend === 's3') {
    return new S3UploadStagingStore(
      createAwsS3Operations({ region: config.region, bucket: config.bucket }),
      { bucket: config.bucket, prefix: config.prefix, ttlMs: config.ttlMs },
    );
  }
  return new FilesystemUploadStagingStore({
    root: config.root,
    prefix: config.prefix,
    ttlMs: config.ttlMs,
    publicBaseUrl: config.publicBaseUrl,
  });
}
