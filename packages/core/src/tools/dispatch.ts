/**
 * Single point that executes one tool call: looks the tool up in the registry,
 * runs it, and turns an unknown tool or a thrown error into an error
 * {@link ToolResult} (failures are data, §4.7). Shared by the harness inner loop
 * (mid-turn calls) and the approval-confirm route (the approved effectful call),
 * so dispatch behaves identically on both paths.
 */

import type { ToolResult, TurnCtx } from '../harness/hooks.js';
import { consoleLogger, type Logger } from '../logging.js';
import type { ToolRegistry } from './registry.js';
import { toolErrorMessage } from './tool.js';

export async function dispatchTool(
  registry: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
  ctx: TurnCtx,
  logger: Logger = consoleLogger,
  toolCallId?: string,
): Promise<ToolResult> {
  const withId = (result: ToolResult): ToolResult =>
    toolCallId !== undefined ? { ...result, toolCallId } : result;
  const tool = registry.get(name);
  if (!tool) {
    return withId({ name, content: `Error: unknown tool "${name}".` });
  }
  try {
    return withId(await tool.run(args, ctx));
  } catch (error) {
    logger.error('tool execution threw', {
      operation: 'dispatchTool',
      companionId: ctx.companionId,
      tool: name,
      error,
    });
    return withId({ name, content: `Error: ${toolErrorMessage(error)}` });
  }
}
