// S3 bucket for upload staging (staging-object-storage.md). A browser PUTs a file's
// bytes straight to this bucket via a presigned URL under the `tmp-uploads/` prefix;
// the `ingest` job reads them back on any node, then deletes them. A lifecycle rule
// expires anything left under the prefix after a day — the GC that makes a
// staged-but-never-consumed object self-heal (no application sweep can fail to run).
// Private (no public access); reached only through presigned URLs.
import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

const tags = { Project: 'cobblecompanion', ManagedBy: 'pulumi' };
const cfg = new pulumi.Config();
const domain = cfg.require('domain');

/** Key prefix for staged uploads; mirrors `UPLOAD_STAGING_PREFIX` in the app. */
export const UPLOAD_PREFIX = 'tmp-uploads';

// Name is auto-generated (S3 names are globally unique); the app receives the real
// name via UPLOAD_STAGING_S3_BUCKET (compute.ts). forceDestroy: the bucket holds
// only ephemeral staging bytes, so `pulumi destroy` may empty + remove it.
export const uploadsBucket = new aws.s3.BucketV2('cc-uploads', {
  bucketPrefix: 'cc-uploads-',
  forceDestroy: true,
  tags,
});

// Block all public access — staged bytes are reached only via presigned URLs.
new aws.s3.BucketPublicAccessBlock('cc-uploads-pab', {
  bucket: uploadsBucket.id,
  blockPublicAcls: true,
  blockPublicPolicy: true,
  ignorePublicAcls: true,
  restrictPublicBuckets: true,
});

// Encrypt at rest (SSE-S3) — matches the stack's `encrypted: true` convention.
new aws.s3.BucketServerSideEncryptionConfigurationV2('cc-uploads-sse', {
  bucket: uploadsBucket.id,
  rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: 'AES256' } }],
});

// TTL: a staged upload is normally consumed in seconds. Expire anything left under
// the prefix after 1 day and abort dangling multipart uploads — this reclaims a
// staged-but-never-enqueued object server-side (staging-object-storage.md §2).
new aws.s3.BucketLifecycleConfigurationV2('cc-uploads-lifecycle', {
  bucket: uploadsBucket.id,
  rules: [
    {
      id: 'expire-tmp-uploads',
      status: 'Enabled',
      filter: { prefix: `${UPLOAD_PREFIX}/` },
      expiration: { days: 1 },
      abortIncompleteMultipartUpload: { daysAfterInitiation: 1 },
    },
  ],
});

// CORS: the browser uploads bytes directly to the bucket via a presigned PUT, so
// the app origin must be allowed for PUT (staging-object-storage.md §3.1).
new aws.s3.BucketCorsConfigurationV2('cc-uploads-cors', {
  bucket: uploadsBucket.id,
  corsRules: [
    {
      allowedMethods: ['PUT'],
      allowedOrigins: [pulumi.interpolate`https://${domain}`],
      allowedHeaders: ['*'],
      exposeHeaders: ['ETag'],
      maxAgeSeconds: 3000,
    },
  ],
});
