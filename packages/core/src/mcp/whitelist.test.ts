/**
 * McpWhitelist — the entire MCP trust decision (companion-tools.md §6). These
 * tests pin the construction-time fail-fast guarantees: a non-empty unique
 * `ref` and a public http(s) `endpoint` (the ingestion SSRF string guard). The
 * SSRF rejection here is the real defense the Phase 9 DoD test plan calls for;
 * the off-whitelist-at-connect path is covered separately in phase9-dod.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { McpWhitelist, type McpWhitelistEntry } from './whitelist.js';

const stocks: McpWhitelistEntry = { ref: 'stocks', endpoint: 'https://mcp.example.com' };

describe('McpWhitelist', () => {
  describe('construction guards', () => {
    it('rejects an entry with an empty ref', () => {
      expect(() => new McpWhitelist([{ ref: '', endpoint: 'https://mcp.example.com' }])).toThrow(
        /missing a ref/,
      );
    });

    it('rejects an entry whose ref is only whitespace', () => {
      expect(() => new McpWhitelist([{ ref: '   ', endpoint: 'https://mcp.example.com' }])).toThrow(
        /missing a ref/,
      );
    });

    it('rejects duplicate refs', () => {
      expect(
        () =>
          new McpWhitelist([
            { ref: 'stocks', endpoint: 'https://a.example.com' },
            { ref: 'stocks', endpoint: 'https://b.example.com' },
          ]),
      ).toThrow(/duplicate MCP whitelist ref "stocks"/);
    });

    it('rejects a loopback endpoint (SSRF guard)', () => {
      expect(() => new McpWhitelist([{ ref: 'evil', endpoint: 'http://localhost:8080' }])).toThrow(
        /private or internal addresses/,
      );
    });

    it('rejects a private-range IP endpoint (SSRF guard)', () => {
      expect(() => new McpWhitelist([{ ref: 'evil', endpoint: 'http://10.0.0.1' }])).toThrow(
        /private or internal addresses/,
      );
    });

    it('rejects the cloud metadata endpoint (SSRF guard)', () => {
      expect(
        () =>
          new McpWhitelist([{ ref: 'evil', endpoint: 'http://169.254.169.254/latest/meta-data' }]),
      ).toThrow(/private or internal addresses/);
    });

    it('rejects a non-http(s) endpoint scheme (SSRF guard)', () => {
      expect(() => new McpWhitelist([{ ref: 'evil', endpoint: 'file:///etc/passwd' }])).toThrow(
        /only http\(s\) links/,
      );
    });

    it('rejects a malformed endpoint (SSRF guard)', () => {
      expect(() => new McpWhitelist([{ ref: 'evil', endpoint: 'not a url' }])).toThrow(
        /not a valid URL/,
      );
    });

    it('accepts a valid public http(s) entry', () => {
      expect(() => new McpWhitelist([stocks])).not.toThrow();
    });

    it('rejects the whole list when any one entry is invalid', () => {
      expect(
        () => new McpWhitelist([stocks, { ref: 'evil', endpoint: 'http://127.0.0.1' }]),
      ).toThrow(/private or internal addresses/);
    });
  });

  describe('lookups', () => {
    it('isAllowed is true for a listed ref and false otherwise', () => {
      const whitelist = new McpWhitelist([stocks]);
      expect(whitelist.isAllowed('stocks')).toBe(true);
      expect(whitelist.isAllowed('evil')).toBe(false);
    });

    it('get returns the entry for a listed ref and undefined otherwise', () => {
      const whitelist = new McpWhitelist([stocks]);
      expect(whitelist.get('stocks')).toEqual(stocks);
      expect(whitelist.get('evil')).toBeUndefined();
    });

    it('list returns every allowed entry', () => {
      const weather: McpWhitelistEntry = {
        ref: 'weather',
        endpoint: 'https://weather.example.com',
      };
      const whitelist = new McpWhitelist([stocks, weather]);
      expect(whitelist.list()).toEqual([stocks, weather]);
    });

    it('an empty whitelist allows nothing', () => {
      const whitelist = new McpWhitelist();
      expect(whitelist.isAllowed('stocks')).toBe(false);
      expect(whitelist.list()).toEqual([]);
    });
  });
});
