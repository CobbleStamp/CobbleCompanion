/** Upload-staging key codec: round-trips and rejects forged/malformed keys
 *  (staging-object-storage.md §4). */

import { describe, expect, it } from 'vitest';
import { buildUploadKey, parseUploadKey } from './upload-staging.js';

describe('upload-staging key codec', () => {
  const prefix = 'tmp-uploads';

  it('round-trips owner and kind through a built key', () => {
    const key = buildUploadKey(prefix, 'owner-1', 'pdf');
    expect(key.startsWith(`${prefix}/owner-1/`)).toBe(true);
    expect(parseUploadKey(prefix, key)).toEqual({ ownerId: 'owner-1', kind: 'pdf' });
  });

  it('gives a distinct id to each slot for the same owner+kind', () => {
    const a = buildUploadKey(prefix, 'owner-1', 'txt');
    const b = buildUploadKey(prefix, 'owner-1', 'txt');
    expect(a).not.toEqual(b);
  });

  it('rejects a key under the wrong prefix', () => {
    const key = buildUploadKey('other', 'owner-1', 'pdf');
    expect(parseUploadKey(prefix, key)).toBeNull();
  });

  it('rejects an unknown kind suffix', () => {
    expect(parseUploadKey(prefix, `${prefix}/owner-1/abc__exe`)).toBeNull();
  });

  it('rejects a malformed key (extra path segments / traversal)', () => {
    expect(parseUploadKey(prefix, `${prefix}/owner-1/../../etc/passwd__pdf`)).toBeNull();
    expect(parseUploadKey(prefix, `${prefix}/owner-1`)).toBeNull();
    expect(parseUploadKey(prefix, '')).toBeNull();
  });
});
