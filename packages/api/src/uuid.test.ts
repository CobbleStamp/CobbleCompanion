import { describe, expect, it } from 'vitest';
import { isUuid } from './uuid.js';

describe('isUuid', () => {
  it('accepts a canonical lower-case UUID', () => {
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
    expect(isUuid('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true);
  });

  it('accepts upper-case hex (case-insensitive)', () => {
    expect(isUuid('3F2504E0-4F89-41D3-9A0C-0305E82C3301')).toBe(true);
  });

  it('rejects the obvious malformed cases that would 500 a DB query', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid('123')).toBe(false);
    // right length, wrong shape (no hyphens)
    expect(isUuid('3f2504e04f8941d39a0c0305e82c3301')).toBe(false);
    // non-hex character
    expect(isUuid('3f2504e0-4f89-41d3-9a0c-0305e82c330g')).toBe(false);
    // trailing junk / leading whitespace must not slip through
    expect(isUuid('3f2504e0-4f89-41d3-9a0c-0305e82c3301 ')).toBe(false);
    expect(isUuid(' 3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(false);
  });
});
