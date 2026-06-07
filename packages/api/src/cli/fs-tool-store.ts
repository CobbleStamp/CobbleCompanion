/**
 * The production {@link CliToolStore} (companion-tools.md §5/§6) — reads CLI tool
 * definitions from the folders under `CLI_TOOLS_PATH`. Each subfolder is one tool:
 * a `TOOL.json` (machine contract) + `TOOL.md` (usage prompt). This directory is
 * the CLI trust boundary, so it must be read-only + deployment-controlled and must
 * not overlap any path the app writes to.
 *
 * `list` enumerates the catalog; a folder that is missing a file or fails to parse
 * is **skipped and logged**, never crashing the scan ("stale beats gone" parity
 * with the MCP catalog builder). `get` is the call-time re-read seam — a removed
 * folder returns null, so the tool is revoked immediately. A folder ref is
 * validated as a single safe path segment, so no `get(ref)` can traverse outside
 * `CLI_TOOLS_PATH`.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type CliToolDef,
  type CliToolStore,
  type Logger,
  consoleLogger,
  parseCliToolDef,
} from '@cobble/core';

const TOOL_JSON = 'TOOL.json';
const TOOL_MD = 'TOOL.md';
/** A tool folder ref is a single safe path segment — never a traversal. */
const SAFE_REF = /^[a-zA-Z0-9_-]+$/u;

export class FileSystemCliToolStore implements CliToolStore {
  constructor(
    private readonly rootDir: string,
    private readonly logger: Logger = consoleLogger,
  ) {}

  async list(): Promise<readonly CliToolDef[]> {
    let dirents;
    try {
      dirents = await readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      // The whole directory is unreadable — propagate so the catalog builder keeps
      // every stale CLI row rather than pruning them all on a transient failure.
      this.logger.error('CLI tools dir is unreadable', {
        operation: 'cli.fsToolStore.list',
        rootDir: this.rootDir,
        error,
      });
      throw error instanceof Error ? error : new Error('CLI tools dir unreadable');
    }
    const defs: CliToolDef[] = [];
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || !SAFE_REF.test(dirent.name)) {
        continue;
      }
      const def = await this.read(dirent.name);
      if (def) {
        defs.push(def);
      }
    }
    return defs;
  }

  async get(ref: string): Promise<CliToolDef | null> {
    if (!SAFE_REF.test(ref)) {
      return null;
    }
    return this.read(ref);
  }

  /** Read + parse one tool folder; an invalid/incomplete folder is skipped + logged. */
  private async read(ref: string): Promise<CliToolDef | null> {
    const dir = join(this.rootDir, ref);
    try {
      const [toolJson, usage] = await Promise.all([
        readFile(join(dir, TOOL_JSON), 'utf8'),
        readFile(join(dir, TOOL_MD), 'utf8'),
      ]);
      return parseCliToolDef(ref, toolJson, usage);
    } catch (error) {
      this.logger.error('skipping invalid CLI tool folder', {
        operation: 'cli.fsToolStore.read',
        tool: ref,
        error,
      });
      return null;
    }
  }
}
