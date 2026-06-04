/**
 * Sanitize tests: control characters that Postgres `text` rejects (NUL) or that
 * are encoder noise are stripped, while visible text and normal whitespace are
 * preserved. NUL and other control characters are constructed via
 * String.fromCharCode so no control bytes live in this source file.
 */

import { describe, expect, it } from 'vitest';
import { sanitizeText, stripNul } from './sanitize.js';

const NUL = String.fromCharCode(0x00);
const BACKSPACE = String.fromCharCode(0x08);
const UNIT_SEPARATOR = String.fromCharCode(0x1f);
const DELETE = String.fromCharCode(0x7f);

describe('sanitizeText', () => {
  it('strips NUL while keeping surrounding visible text', () => {
    expect(sanitizeText(`hello${NUL}world`)).toBe('helloworld');
  });

  it('strips other C0/C1 control characters', () => {
    expect(sanitizeText(`a${BACKSPACE}b${UNIT_SEPARATOR}c${DELETE}d`)).toBe('abcd');
  });

  it('preserves tab, newline, and carriage return for downstream normalization', () => {
    expect(sanitizeText('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('returns the input unchanged when there is nothing to strip', () => {
    const clean = 'The quick brown fox.';
    expect(sanitizeText(clean)).toBe(clean);
  });
});

describe('stripNul', () => {
  it('removes only NUL', () => {
    expect(stripNul(`a${NUL}b${NUL}c`)).toBe('abc');
  });

  it('leaves other control characters in place', () => {
    const input = `a${BACKSPACE}b`;
    expect(stripNul(input)).toBe(input);
  });

  it('returns the input unchanged when there is no NUL', () => {
    const clean = 'no nulls here';
    expect(stripNul(clean)).toBe(clean);
  });
});
