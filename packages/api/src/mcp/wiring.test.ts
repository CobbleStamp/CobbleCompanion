/**
 * envAuthHeaders: the secret-resolution seam (companion-tools.md §7). A server's
 * bearer token is named by `authTokenEnv` and resolved from the process
 * environment at connect time — never persisted. We pin the three branches:
 * no env name → no header; env present → a Bearer header; env named but unset
 * (or empty) → no header, so a misconfigured token never sends an empty Bearer.
 */

import type { McpWhitelistEntry } from '@cobble/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { envAuthHeaders } from './wiring.js';

const TOKEN_ENV = 'COBBLE_TEST_MCP_TOKEN';
const entry = (overrides: Partial<McpWhitelistEntry> = {}): McpWhitelistEntry => ({
  ref: 'stocks',
  endpoint: 'https://mcp.example.com/mcp',
  ...overrides,
});

describe('envAuthHeaders', () => {
  beforeEach(() => {
    delete process.env[TOKEN_ENV];
  });
  afterEach(() => {
    delete process.env[TOKEN_ENV];
  });

  it('returns undefined when the entry names no auth env var', () => {
    expect(envAuthHeaders(entry())).toBeUndefined();
  });

  it('resolves a Bearer header from the named env var when set', () => {
    process.env[TOKEN_ENV] = 'sekret';
    expect(envAuthHeaders(entry({ authTokenEnv: TOKEN_ENV }))).toEqual({
      Authorization: 'Bearer sekret',
    });
  });

  it('returns undefined when the named env var is unset', () => {
    expect(envAuthHeaders(entry({ authTokenEnv: TOKEN_ENV }))).toBeUndefined();
  });

  it('returns undefined when the named env var is empty (no empty Bearer)', () => {
    process.env[TOKEN_ENV] = '';
    expect(envAuthHeaders(entry({ authTokenEnv: TOKEN_ENV }))).toBeUndefined();
  });
});
