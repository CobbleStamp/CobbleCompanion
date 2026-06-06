/**
 * The developer's MCP server whitelist — the entire trust decision for the MCP
 * track (companion-tools.md §6). Only servers listed here may be connected; the
 * runtime outcome is binary (allowed → runs free, otherwise denied). Entries are
 * validated at construction (fail-fast): a non-empty unique `ref` and a public
 * http(s) `endpoint` (reusing the ingestion SSRF string guard). Auth, if any, is
 * referenced by env-var name and resolved at connect time — never stored here.
 */

import { assertPublicHttpUrl } from '../ingestion/url-guard.js';

export interface McpWhitelistEntry {
  /** Stable alias the model connects by and connection rows key on. */
  readonly ref: string;
  /** The server's HTTP/SSE endpoint (public http(s); SSRF-validated). */
  readonly endpoint: string;
  /** Optional human label for surfaces. */
  readonly label?: string;
  /** Name of the env/secret-manager var holding a bearer token, when the server needs auth. */
  readonly authTokenEnv?: string;
}

export class McpWhitelist {
  private readonly byRef: Map<string, McpWhitelistEntry>;

  constructor(entries: readonly McpWhitelistEntry[] = []) {
    const byRef = new Map<string, McpWhitelistEntry>();
    for (const entry of entries) {
      if (entry.ref.trim().length === 0) {
        throw new Error('MCP whitelist entry is missing a ref');
      }
      if (byRef.has(entry.ref)) {
        throw new Error(`duplicate MCP whitelist ref "${entry.ref}"`);
      }
      // Only public http(s) endpoints — the same string-level guard link
      // ingestion uses (architecture.md §8). Throws a user-safe Error otherwise.
      assertPublicHttpUrl(entry.endpoint);
      byRef.set(entry.ref, entry);
    }
    this.byRef = byRef;
  }

  /** Whether a server ref is allowed to be connected. */
  isAllowed(ref: string): boolean {
    return this.byRef.has(ref);
  }

  /** The whitelist entry for a ref, or undefined when it isn't allowed. */
  get(ref: string): McpWhitelistEntry | undefined {
    return this.byRef.get(ref);
  }

  /** All allowed entries (for advertising the choices to the model + surfaces). */
  list(): readonly McpWhitelistEntry[] {
    return [...this.byRef.values()];
  }
}
