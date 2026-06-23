/**
 * Real-SDK regression guard for the one security-critical property of the AWS
 * adapter: `presignPut` must sign `content-length` into the URL. The store's own
 * test (upload-staging-s3.test.ts) uses a fake and so can only assert the value is
 * passed through — it cannot prove SigV4 actually pins it. This test loads the real
 * `@aws-sdk` presigner and inspects `X-Amz-SignedHeaders`, so a future SDK upgrade
 * that stopped signing `content-length` (silently defeating the upload size cap —
 * see upload-staging-s3-aws.ts presignPut) would fail here instead of in production.
 */

import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { AwsS3Operations } from './upload-staging-s3-aws.js';

function ops(): AwsS3Operations {
  // Static dummy credentials so presigning is deterministic and offline (no
  // provider-chain lookup, no network).
  const client = new S3Client({
    region: 'us-east-1',
    credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secretexample' },
  });
  return new AwsS3Operations(client, 'cc-uploads');
}

describe('AwsS3Operations.presignPut', () => {
  it('signs content-length into the URL so S3 caps the body at the declared size', async () => {
    const url = await ops().presignPut('tmp-uploads/owner-1/abc__pdf', {
      contentType: 'application/pdf',
      contentLength: 700,
      expiresInSec: 3600,
    });

    const signed = new URL(url).searchParams.get('X-Amz-SignedHeaders') ?? '';
    // `content-length` in SignedHeaders means the client must send exactly this
    // value or SigV4 fails with SignatureDoesNotMatch — the cap is enforced at the
    // signature, not just advisory.
    expect(signed.split(';')).toContain('content-length');
  });

  it('omits content-length from the signature when no size is pinned', async () => {
    const url = await ops().presignPut('tmp-uploads/owner-1/abc__pdf', {
      expiresInSec: 3600,
    });

    const signed = new URL(url).searchParams.get('X-Amz-SignedHeaders') ?? '';
    expect(signed.split(';')).not.toContain('content-length');
  });
});
