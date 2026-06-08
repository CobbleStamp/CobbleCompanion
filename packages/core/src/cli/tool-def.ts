/**
 * A CLI tool definition (companion-tools.md §3/§6) — the CLI analogue of an MCP
 * server's self-description, but **developer-authored** rather than fetched. One
 * lives per tool folder under `CLI_TOOLS_PATH`:
 *
 *  - `TOOL.json` — the machine contract parsed here: the `binary` to run, a short
 *    catalog `description`, the model-facing `parameters` JSON Schema, the `argv`
 *    template mapping validated params → discrete argv elements, and the mandatory
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

/** Mandatory per-tool resource ceilings the sandbox enforces for every run. */
export interface CliToolLimits {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
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
  readonly limits: CliToolLimits;
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
    limits,
  };
}

/**
 * Find argv placeholders whose substituted value the **binary's own argument
 * parser** could read as an option flag rather than as data — "option injection".
 * The no-shell sandbox keeps every value a single argv element (so shell
 * metacharacters are inert), but it cannot stop the binary from treating a value
 * like `-rf` or `--config=/x` as a flag when that value lands at the **start** of
 * an argv token. Whitelisting fixes the *binary* and the *argv template*, never the
 * model-supplied *value* — so a bare-placeholder element (`['{query}']`) is the gap.
 *
 * A placeholder is safe when a fixed literal sits before it in the same element
 * (`--in={path}`, `-p{path}`), so the rendered token never begins with the value;
 * or when a standalone `--` element precedes it (POSIX end-of-options), provided the
 * binary honours `--`. Returns the deduped, sorted names of placeholders that sit in
 * an option-injectable position — empty when the template is fully anchored.
 */
export function unsafeArgvPlaceholders(argv: readonly string[]): string[] {
  const unsafe = new Set<string>();
  let afterDoubleDash = false;
  for (const element of argv) {
    if (element === '--') {
      afterDoubleDash = true;
      continue; // a literal `--` makes every later element an operand, never an option
    }
    if (afterDoubleDash) {
      continue;
    }
    let cursor = 0;
    let literalBefore = false;
    for (const match of element.matchAll(PLACEHOLDER)) {
      const index = match.index ?? 0;
      if (index > cursor) {
        literalBefore = true; // fixed text precedes this placeholder within the token
      }
      if (!literalBefore) {
        unsafe.add(match[1] ?? '');
      }
      cursor = index + match[0].length;
    }
  }
  return [...unsafe].sort();
}

function parseLimits(raw: unknown): CliToolLimits {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('TOOL.json "limits" must be an object with timeoutMs and maxOutputBytes');
  }
  const obj = raw as Record<string, unknown>;
  const positiveInt = (value: unknown, key: string): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new Error(`TOOL.json "limits.${key}" must be a positive integer`);
    }
    return value;
  };
  return {
    timeoutMs: positiveInt(obj['timeoutMs'], 'timeoutMs'),
    maxOutputBytes: positiveInt(obj['maxOutputBytes'], 'maxOutputBytes'),
  };
}
