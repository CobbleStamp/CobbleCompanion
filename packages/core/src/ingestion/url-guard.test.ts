/**
 * SSRF guard tests: public http(s) passes; private/internal/metadata targets
 * throw — including encoded IPv6 forms (NAT64, IPv4-mapped, 6to4) and, via
 * the guarded lookup, public hostnames whose DNS records point at private
 * addresses (rebinding).
 */

import type { lookup as dnsLookup, LookupAddress } from 'node:dns';
import { describe, expect, it } from 'vitest';
import { assertPublicHttpUrl, createGuardedLookup, isBlockedIpAddress } from './url-guard.js';

describe('assertPublicHttpUrl', () => {
  it.each([
    'https://example.com/article',
    'http://93.184.216.34/page',
    'https://sub.domain.co.uk/path?q=1',
    'https://[2606:4700::6810:84e5]/page',
    // IPv4-mapped form of a *public* address is fine — the embedded IP is checked.
    'http://[::ffff:93.184.216.34]/page',
  ])('accepts public URL %s', (url) => {
    expect(assertPublicHttpUrl(url).href).toBe(new URL(url).href);
  });

  it.each([
    ['not a URL', 'not-a-url'],
    ['non-http scheme', 'file:///etc/passwd'],
    ['gopher scheme', 'gopher://example.com'],
    ['localhost', 'http://localhost:3000/admin'],
    ['localhost subdomain', 'http://api.localhost/x'],
    ['loopback IPv4', 'http://127.0.0.1/secrets'],
    ['loopback IPv4 high', 'http://127.255.255.254/'],
    ['cloud metadata IP', 'http://169.254.169.254/computeMetadata/v1/'],
    ['GCP metadata hostname', 'http://metadata.google.internal/computeMetadata/v1/'],
    ['internal suffix', 'https://service.cluster.internal/'],
    ['private 10.x', 'http://10.0.0.5/'],
    ['private 172.16', 'http://172.16.0.1/'],
    ['private 192.168', 'http://192.168.1.1/router'],
    ['CGNAT', 'http://100.64.0.1/'],
    ['unspecified', 'http://0.0.0.0/'],
    ['IPv4 multicast', 'http://224.0.0.1/'],
    ['IPv4 broadcast', 'http://255.255.255.255/'],
    ['benchmarking 198.18/15', 'http://198.18.0.1/'],
    ['protocol assignments 192.0.0/24', 'http://192.0.0.170/'],
    ['IPv6 loopback', 'http://[::1]/'],
    ['IPv6 link-local', 'http://[fe80::1]/'],
    ['IPv6 site-local', 'http://[fec0::1]/'],
    ['IPv6 unique-local', 'http://[fd00::1]/'],
    ['IPv6 multicast', 'http://[ff02::1]/'],
    ['IPv4-mapped metadata', 'http://[::ffff:169.254.169.254]/'],
    ['IPv4-mapped private', 'http://[::ffff:10.0.0.1]/'],
    ['IPv4-compatible loopback', 'http://[::127.0.0.1]/'],
    ['NAT64 metadata (dotted)', 'http://[64:ff9b::169.254.169.254]/'],
    ['NAT64 metadata (hex)', 'http://[64:ff9b::a9fe:a9fe]/'],
    ['NAT64 local-use', 'http://[64:ff9b:1::a9fe:a9fe]/'],
    ['6to4 of 10.0.0.1', 'http://[2002:a00:1::]/'],
    ['Teredo prefix', 'http://[2001:0:1234::1]/'],
  ])('rejects %s', (_label, url) => {
    expect(() => assertPublicHttpUrl(url)).toThrow();
  });
});

describe('isBlockedIpAddress', () => {
  it('passes ordinary hostnames through (judged by resolution, not by name)', () => {
    expect(isBlockedIpAddress('example.com')).toBe(false);
  });

  it('blocks an unparseable colon-form rather than letting it through', () => {
    expect(isBlockedIpAddress('fe80::1::2')).toBe(true);
  });

  it('blocks bare (unbracketed) IPv6 forms as returned by DNS', () => {
    expect(isBlockedIpAddress('64:ff9b::a9fe:a9fe')).toBe(true);
    expect(isBlockedIpAddress('fd00::1')).toBe(true);
    expect(isBlockedIpAddress('2606:4700::6810:84e5')).toBe(false);
  });
});

/** Fake resolver: maps hostnames to fixed lookup answers (fakes over mocks). */
function fakeResolver(answers: Record<string, readonly LookupAddress[]>): typeof dnsLookup {
  return ((hostname: string, _options: unknown, callback: unknown) => {
    const reply = callback as (
      error: NodeJS.ErrnoException | null,
      addresses: LookupAddress[],
    ) => void;
    const found = answers[hostname];
    if (!found) {
      reply(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }), []);
      return;
    }
    reply(null, [...found]);
  }) as typeof dnsLookup;
}

/** Promisified call through the net-style lookup the guarded fetch uses. */
function runLookup(
  lookup: ReturnType<typeof createGuardedLookup>,
  hostname: string,
  all: boolean,
): Promise<{ address: string | LookupAddress[]; family?: number }> {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all }, (error, address, family) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(family === undefined ? { address } : { address, family });
    });
  });
}

describe('createGuardedLookup', () => {
  const lookup = createGuardedLookup(
    fakeResolver({
      'good.example': [{ address: '93.184.216.34', family: 4 }],
      'rebind.example': [{ address: '169.254.169.254', family: 4 }],
      'mixed.example': [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ],
      'v6-private.example': [{ address: 'fd00::1', family: 6 }],
      'empty.example': [],
    }),
  );

  it('resolves a hostname whose addresses are all public', async () => {
    const single = await runLookup(lookup, 'good.example', false);
    expect(single).toEqual({ address: '93.184.216.34', family: 4 });
    const all = await runLookup(lookup, 'good.example', true);
    expect(all.address).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('rejects a public hostname whose DNS record points at a private IP (rebinding)', async () => {
    await expect(runLookup(lookup, 'rebind.example', false)).rejects.toThrow(/private or internal/);
  });

  it('rejects when ANY resolved address is private, even alongside public ones', async () => {
    await expect(runLookup(lookup, 'mixed.example', true)).rejects.toThrow(/private or internal/);
  });

  it('rejects a hostname resolving to a private IPv6 address', async () => {
    await expect(runLookup(lookup, 'v6-private.example', false)).rejects.toThrow(
      /private or internal/,
    );
  });

  it('propagates resolution failures and rejects empty answers', async () => {
    await expect(runLookup(lookup, 'missing.example', false)).rejects.toThrow(/ENOTFOUND/);
    await expect(runLookup(lookup, 'empty.example', false)).rejects.toThrow(
      /could not be resolved/,
    );
  });
});
