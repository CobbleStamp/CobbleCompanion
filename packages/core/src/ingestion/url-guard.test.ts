/** SSRF guard tests: public http(s) passes; private/internal/metadata targets throw. */

import { describe, expect, it } from 'vitest';
import { assertPublicHttpUrl } from './url-guard.js';

describe('assertPublicHttpUrl', () => {
  it.each([
    'https://example.com/article',
    'http://93.184.216.34/page',
    'https://sub.domain.co.uk/path?q=1',
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
    ['IPv6 loopback', 'http://[::1]/'],
    ['IPv6 link-local', 'http://[fe80::1]/'],
    ['IPv6 unique-local', 'http://[fd00::1]/'],
  ])('rejects %s', (_label, url) => {
    expect(() => assertPublicHttpUrl(url)).toThrow();
  });
});
