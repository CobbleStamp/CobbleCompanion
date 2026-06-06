/**
 * The tool registry: the set of tools available to a turn. The harness asks it
 * for the advertised tool list (passed to the gateway) and looks a tool up by
 * name to dispatch a call. An empty registry reproduces the Phase 0 path (no
 * tools advertised → the model never calls one).
 */

import { consoleLogger, type Logger } from '../logging.js';
import type { ToolDef } from '../llm/gateway.js';
import { type Tool, toToolDef } from './tool.js';

export class ToolRegistry {
  private readonly byName: Map<string, Tool>;

  constructor(
    private readonly tools: readonly Tool[] = [],
    logger: Logger = consoleLogger,
  ) {
    this.byName = new Map();
    for (const tool of tools) {
      if (this.byName.has(tool.name)) {
        // A duplicate advertised name silently shadows the earlier tool in
        // by-name dispatch (the later one wins) while both still appear in
        // list() — surface it rather than dropping a tool quietly.
        logger.warn('tool name collision in registry; later tool shadows earlier', {
          operation: 'tools.registry',
          name: tool.name,
        });
      }
      this.byName.set(tool.name, tool);
    }
  }

  /** The tools advertised to the model this turn (empty → a text-only call). */
  list(): readonly ToolDef[] {
    return this.tools.map(toToolDef);
  }

  /** The tool with this name, or undefined if the model named an unknown one. */
  get(name: string): Tool | undefined {
    return this.byName.get(name);
  }

  /** How many tools are registered (0 → the Phase 0 trivial path). */
  get size(): number {
    return this.tools.length;
  }
}
