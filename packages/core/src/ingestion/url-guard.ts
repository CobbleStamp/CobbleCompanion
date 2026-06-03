/**
 * SSRF guard for link ingestion: the pipeline fetches user-supplied URLs
 * server-side, so destinations must be restricted to public HTTP(S) hosts —
 * never loopback, private/link-local ranges, or cloud metadata endpoints
 * (architecture.md §8 input-validation boundary). Two layers:
 *
 * 1. `assertPublicHttpUrl` — string-level scheme/hostname/IP-literal checks,
 *    cheap and synchronous, run before a job is queued.
 * 2. `createGuardedLookup` — a DNS lookup for the fetch's connection layer
 *    that validates every *resolved* address at connect time. This is the
 *    real defense: a public hostname can point its DNS record at a private
 *    IP (rebinding), which no string inspection can catch. Because the
 *    validation happens inside the same lookup the socket uses, there is no
 *    check-then-connect gap.
 *
 * Redirects are refused separately (the pipeline fetches with
 * `redirect: 'error'`), but every connection — redirect or not — goes
 * through the guarded lookup.
 */

import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import type { LookupFunction } from 'node:net';

/** Hostnames that must never be fetched, regardless of resolution. */
const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal']);

/** Hostname suffixes for internal/cloud-local namespaces. */
const BLOCKED_SUFFIXES = ['.localhost', '.internal', '.local'];

const PRIVATE_ADDRESS_MESSAGE = 'links to private or internal addresses cannot be read';

/**
 * Validate that a user-supplied link is a public HTTP(S) URL; throws a
 * user-safe Error otherwise. String-level layer only — the resolved
 * addresses are re-checked at connect time by `createGuardedLookup`.
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
    isBlockedIpAddress(hostname)
  ) {
    throw new Error(PRIVATE_ADDRESS_MESSAGE);
  }
  return url;
}

/**
 * True when `host` is an IP literal in a loopback/private/reserved range.
 * Non-IP hostnames return false (they are judged by resolution instead).
 * IPv6 literals may be bracket-wrapped (URL hostname form) or bare (as
 * returned by DNS resolution).
 */
export function isBlockedIpAddress(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (bare.includes(':')) {
    const groups = parseIpv6(bare);
    // Unparseable colon-form is never a valid public destination.
    return groups === null ? true : isBlockedIpv6(groups);
  }
  const octets = parseIpv4(bare);
  return octets === null ? false : isBlockedIpv4(octets);
}

/**
 * DNS lookup function for the fetch connection layer: resolves via
 * `baseLookup` and rejects the connection when *any* resolved address is in
 * a blocked range. Injectable base lookup so tests can fake resolution
 * (e.g. a public name pointing at a private IP).
 */
export function createGuardedLookup(baseLookup: typeof dnsLookup = dnsLookup): LookupFunction {
  return (hostname, options, callback) => {
    const lookupAll: LookupOptions = { ...options, all: true };
    baseLookup(hostname, lookupAll, (error, result) => {
      if (error) {
        callback(error, '', 4);
        return;
      }
      const addresses = Array.isArray(result)
        ? result
        : [{ address: result, family: 4 } satisfies LookupAddress];
      if (addresses.length === 0) {
        callback(new Error('the link could not be resolved'), '', 4);
        return;
      }
      const blocked = addresses.find((entry) => isBlockedIpAddress(entry.address));
      if (blocked) {
        callback(new Error(PRIVATE_ADDRESS_MESSAGE), '', 4);
        return;
      }
      if (options.all) {
        callback(null, addresses);
      } else {
        callback(null, addresses[0]!.address, addresses[0]!.family);
      }
    });
  };
}

/** Strict dotted-quad parse; returns null when `host` is not an IPv4 literal. */
function parseIpv4(host: string): readonly [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return null;
  }
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) {
    return null;
  }
  return octets as unknown as readonly [number, number, number, number];
}

function isBlockedIpv4([a, b]: readonly [number, number, number, number]): boolean {
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 || // 10.0.0.0/8 private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10
    (a === 169 && b === 254) || // link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
    (a === 192 && b === 0) || // 192.0.0.0/24 protocol assignments + 192.0.2.0/24 TEST-NET
    (a === 192 && b === 168) || // 192.168.0.0/16 private
    (a === 198 && (b === 18 || b === 19)) || // 198.18.0.0/15 benchmarking
    a >= 224 // multicast 224/4 + reserved 240/4 + broadcast
  );
}

/**
 * Parse an IPv6 literal (no brackets, optional `%zone`, optional embedded
 * dotted-quad tail) into its eight 16-bit groups; null when malformed.
 */
function parseIpv6(literal: string): readonly number[] | null {
  const [address] = literal.split('%');
  if (address === undefined || address.length === 0) {
    return null;
  }
  // Rewrite an embedded IPv4 tail (`::ffff:10.0.0.1`) as two hex groups so
  // range checks below see the real numeric value.
  let working = address;
  const v4Tail = /^(.+:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(address);
  if (v4Tail) {
    const octets = parseIpv4(v4Tail[2]!);
    if (octets === null) {
      return null;
    }
    const [a, b, c, d] = octets;
    working = `${v4Tail[1]!}${(((a << 8) | b) >>> 0).toString(16)}:${(((c << 8) | d) >>> 0).toString(16)}`;
  }
  const halves = working.split('::');
  if (halves.length > 2) {
    return null;
  }
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups: readonly string[];
  if (halves.length === 1) {
    if (head.length !== 8) {
      return null;
    }
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) {
      return null;
    }
    groups = [...head, ...Array.from({ length: missing }, () => '0'), ...tail];
  }
  const numbers = groups.map((group) =>
    /^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : -1,
  );
  return numbers.some((value) => value < 0) ? null : numbers;
}

function isBlockedIpv6(groups: readonly number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const leadingZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (leadingZero && g5 === 0) {
    // ::, ::1, and deprecated IPv4-compatible ::a.b.c.d — judge the tail.
    return g6 === 0 && g7 <= 1 ? true : isBlockedEmbeddedIpv4(g6, g7);
  }
  if (leadingZero && g5 === 0xffff) {
    return isBlockedEmbeddedIpv4(g6, g7); // IPv4-mapped ::ffff:a.b.c.d
  }
  if (g0 === 0x64 && g1 === 0xff9b) {
    // NAT64: well-known 64:ff9b::/96 carries the IPv4 in the tail; the
    // local-use 64:ff9b:1::/48 range is never a public destination.
    return g2 === 0 ? isBlockedEmbeddedIpv4(g6, g7) : true;
  }
  if (g0 === 0x2002) {
    return isBlockedEmbeddedIpv4(g1, g2); // 6to4 2002:aabb:ccdd::/48
  }
  if (g0 === 0x2001 && g1 === 0) {
    return true; // Teredo 2001:0::/32 — obfuscated tunnel endpoints, never fetchable
  }
  return (
    (g0 >= 0xfe80 && g0 <= 0xfeff) || // link-local fe80::/10 + site-local fec0::/10
    (g0 >= 0xfc00 && g0 <= 0xfdff) || // unique-local fc00::/7
    g0 >= 0xff00 // multicast ff00::/8
  );
}

/** Apply the IPv4 range checks to an address embedded in two IPv6 groups. */
function isBlockedEmbeddedIpv4(high: number, low: number): boolean {
  return isBlockedIpv4([(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff]);
}
