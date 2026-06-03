/**
 * SSRF guard for link ingestion: the pipeline fetches user-supplied URLs
 * server-side, so destinations must be restricted to public HTTP(S) hosts —
 * never loopback, private/link-local ranges, or cloud metadata endpoints
 * (architecture.md §8 input-validation boundary). Validation is by scheme and
 * hostname/IP-literal inspection; redirects are not followed (the pipeline
 * fetches with `redirect: 'error'`), so every fetched destination passes
 * through this guard.
 */

/** Hostnames that must never be fetched, regardless of resolution. */
const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal']);

/** Hostname suffixes for internal/cloud-local namespaces. */
const BLOCKED_SUFFIXES = ['.localhost', '.internal', '.local'];

/**
 * Validate that a user-supplied link is a public HTTP(S) URL; throws a
 * user-safe Error otherwise. Defense for direct targets — combined with
 * `redirect: 'error'` on the fetch so a public URL cannot bounce to a
 * private one.
 */
export function assertPublicHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('the link is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('only http(s) links can be read');
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
    isBlockedIpLiteral(hostname)
  ) {
    throw new Error('links to private or internal addresses cannot be read');
  }
  return url;
}

/** True when the hostname is an IP literal in a loopback/private/reserved range. */
function isBlockedIpLiteral(hostname: string): boolean {
  // IPv6 literal (URL hostnames wrap them in brackets, stripped by URL parsing).
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (bare.includes(':')) {
    const lower = bare.toLowerCase();
    return (
      lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fe80:') || // link-local
      lower.startsWith('fc') || // unique-local fc00::/7
      lower.startsWith('fd') ||
      lower.startsWith('::ffff:') // IPv4-mapped — re-check the embedded IPv4
    );
  }
  const octets = bare.split('.');
  if (octets.length !== 4 || octets.some((o) => !/^\d{1,3}$/.test(o))) {
    return false; // not an IPv4 literal
  }
  const [a, b] = octets.map(Number) as [number, number, number, number];
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10.0.0.0/8
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10
    (a === 169 && b === 254) || // link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) // 192.168.0.0/16
  );
}
