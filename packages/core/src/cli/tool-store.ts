/**
 * The CLI tool-definition store (companion-tools.md §5/§6) — *where* a CLI
 * source's tool definitions come from. The production store (api) scans
 * `CLI_TOOLS_PATH` and parses each folder's TOOL.json/TOOL.md; this interface lets
 * the CLI capability source stay storage-agnostic and lets tests use an in-memory
 * fake. `get` is the call-time re-read seam: the capability source resolves a
 * tool's fresh definition through it on every load and every call, so removing a
 * tool from the store revokes it immediately (the CLI analogue of de-whitelisting
 * an MCP server).
 */

import type { CliToolDef } from './tool-def.js';

export interface CliToolStore {
  /** Every currently-defined CLI tool — the source enumerates the catalog from this. */
  list(): Promise<readonly CliToolDef[]>;
  /** One tool's fresh definition by folder ref, or null when it no longer exists. */
  get(ref: string): Promise<CliToolDef | null>;
}

/** An in-memory {@link CliToolStore} for tests — fakes our own seam, no filesystem. */
export class InMemoryCliToolStore implements CliToolStore {
  private readonly defs: Map<string, CliToolDef>;

  constructor(initial: readonly CliToolDef[] = []) {
    this.defs = new Map(initial.map((def) => [def.ref, def]));
  }

  async list(): Promise<readonly CliToolDef[]> {
    return [...this.defs.values()];
  }

  async get(ref: string): Promise<CliToolDef | null> {
    return this.defs.get(ref) ?? null;
  }

  /** Test helper: add/replace a definition. */
  set(def: CliToolDef): void {
    this.defs.set(def.ref, def);
  }

  /** Test helper: remove a definition (simulate deleting the tool folder). */
  remove(ref: string): void {
    this.defs.delete(ref);
  }
}
