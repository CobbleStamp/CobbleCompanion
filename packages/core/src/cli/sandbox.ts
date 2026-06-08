/**
 * The CLI execution seam (companion-tools.md §3/§7) — mirrors the MCP gateway
 * seam: core defines the interface + a test fake, the production implementation
 * (a real subprocess with ceilings) lives in the api package. The companion drives
 * a whitelisted host CLI only through this interface, so the isolation policy
 * (per-tenant working dir, scrubbed env, time/output ceilings) can change without
 * touching the tool layer.
 *
 * The sandbox owns the working directory and resource limits — the caller passes
 * only *what* to run (binary + an explicit argv array, never a shell string) and
 * *for whom* (`companionId`, for per-tenant isolation). A failed run is data, not
 * a throw: a non-zero exit / timeout surfaces in the {@link CommandResult}.
 */

/** One sandboxed command invocation. `argv` elements are passed verbatim — no shell. */
export interface CommandRequest {
  /** The companion the run is for — the sandbox isolates working dirs per tenant. */
  readonly companionId: string;
  /** The executable to run (resolved/validated by the sandbox, never a shell line). */
  readonly binary: string;
  /** Arguments as discrete argv elements — never concatenated or shell-interpreted. */
  readonly argv: readonly string[];
  /** Wall-clock ceiling; the process is killed past it. */
  readonly timeoutMs: number;
  /** Output is captured up to this many bytes, then truncated. */
  readonly maxOutputBytes: number;
}

/** The flattened outcome of a sandboxed run — combined output + how it ended. */
export interface CommandResult {
  /** Combined stdout+stderr, decoded and capped at `maxOutputBytes`. */
  readonly output: string;
  /** Process exit code, or `null` when the process was killed (e.g. timed out). */
  readonly exitCode: number | null;
  /** Whether the wall-clock ceiling killed the process. */
  readonly timedOut: boolean;
  /** Whether the output was truncated at the byte cap. */
  readonly truncated: boolean;
}

export interface CommandSandbox {
  /** Run one command under the sandbox's isolation + ceilings. Resolves, never rejects on process error. */
  run(request: CommandRequest): Promise<CommandResult>;
}

/**
 * A test {@link CommandSandbox} that records every request and returns whatever the
 * supplied responder produces — fakes our own interface, never a real process
 * (test rule: fakes over mocks). Mirrors {@link FakeMcpGateway}.
 */
export class FakeCommandSandbox implements CommandSandbox {
  readonly calls: CommandRequest[] = [];

  constructor(
    private readonly responder: (request: CommandRequest) => CommandResult | Promise<CommandResult>,
  ) {}

  async run(request: CommandRequest): Promise<CommandResult> {
    this.calls.push(request);
    return this.responder(request);
  }
}
