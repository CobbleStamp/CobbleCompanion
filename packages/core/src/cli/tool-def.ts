/**
 * A CLI tool definition (companion-tools.md §3/§6) — the CLI analogue of an MCP
 * server's self-description, but **developer-authored** rather than fetched. One
 * lives per tool folder under `CLI_TOOLS_PATH`:
 *
 *  - `TOOL.json` — the machine contract parsed here: the `binary` to run, a short
 *    catalog `description`, the model-facing `parameters` JSON Schema, the `argv`
 *    template mapping validated params → discrete argv elements, and optional
 *    resource `limits`.
 *  - `TOOL.md` — the rich usage prompt surfaced as the equipped tool's description.
 *
 * `parseCliToolDef` validates a folder's two files into a {@link CliToolDef} or
 * throws a descriptive error; the filesystem store (api) skips + logs an invalid
 * folder rather than failing the whole scan. The trust boundary is the folder set
 * (a read-only, deployment-controlled directory), so a definition here is trusted
 * input — but it is still validated fail-fast so a malformed file can't produce an
 * un-runnable or placeholder-mismatched tool.
 */

/** Optional per-tool resource ceilings; the sandbox falls back to deployment defaults. */
export interface CliToolLimits {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface CliToolDef {
  /** The tool folder name — the catalog id segment (`cli__<ref>`) and equipped key. */
  readonly ref: string;
  /** The executable to run (resolved/validated by the sandbox at exec time). */
  readonly binary: string;
  /** One-line catalog description `search_tools` ranks over. */
  readonly description: string;
  /** The rich usage prompt (TOOL.md), shown as the equipped tool's description. */
  readonly usage: string;
  /** Model-facing argument schema (JSON Schema object). */
  readonly parameters: Record<string, unknown>;
  /** argv template: literals + `{param}` placeholders → discrete argv elements. */
  readonly argv: readonly string[];
  readonly limits?: CliToolLimits;
}

/** Matches `{paramName}` placeholders inside an argv template element. */
const PLACEHOLDER = /\{(\w+)\}/gu;

/**
 * Parse + validate a tool folder's `TOOL.json` (raw text) and `TOOL.md` (usage)
 * into a {@link CliToolDef}. Throws a descriptive Error on any problem: bad JSON,
 * a missing/blank `binary` or `description`, a non-object `parameters`, an empty
 * or non-string-array `argv`, or an argv placeholder that names a parameter the
 * schema does not declare (a guaranteed-broken invocation).
 */
export function parseCliToolDef(ref: string, toolJson: string, usage: string): CliToolDef {
  if (ref.trim().length === 0) {
    throw new Error('CLI tool is missing a folder name');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(toolJson);
  } catch (error) {
    throw new Error(`TOOL.json is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('TOOL.json must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  const binary = obj['binary'];
  if (typeof binary !== 'string' || binary.trim().length === 0) {
    throw new Error('TOOL.json "binary" must be a non-empty string');
  }
  const description = obj['description'];
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new Error('TOOL.json "description" must be a non-empty string');
  }
  const parameters = obj['parameters'];
  if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) {
    throw new Error('TOOL.json "parameters" must be a JSON Schema object');
  }
  const argvRaw = obj['argv'];
  if (!Array.isArray(argvRaw) || argvRaw.some((el) => typeof el !== 'string')) {
    throw new Error('TOOL.json "argv" must be an array of strings');
  }
  const argv = argvRaw as string[];

  // Every placeholder must name a declared parameter, or the invocation is broken.
  const declared = new Set(
    Object.keys((parameters as Record<string, unknown>)['properties'] ?? {}),
  );
  for (const element of argv) {
    for (const match of element.matchAll(PLACEHOLDER)) {
      const name = match[1] ?? '';
      if (!declared.has(name)) {
        throw new Error(`argv references undeclared parameter "{${name}}"`);
      }
    }
  }

  const limits = parseLimits(obj['limits']);
  return {
    ref,
    binary,
    description,
    usage,
    parameters: parameters as Record<string, unknown>,
    argv,
    ...(limits ? { limits } : {}),
  };
}

function parseLimits(raw: unknown): CliToolLimits | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('TOOL.json "limits" must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const positiveInt = (value: unknown, key: string): number | undefined => {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new Error(`TOOL.json "limits.${key}" must be a positive integer`);
    }
    return value;
  };
  const timeoutMs = positiveInt(obj['timeoutMs'], 'timeoutMs');
  const maxOutputBytes = positiveInt(obj['maxOutputBytes'], 'maxOutputBytes');
  if (timeoutMs === undefined && maxOutputBytes === undefined) {
    return undefined;
  }
  return {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
  };
}
