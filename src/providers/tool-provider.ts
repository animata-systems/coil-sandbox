/**
 * ToolProvider: routes ВЫПОЛНИ calls to loaded tool handlers.
 *
 * Maps abstract tool names (from COIL scenario) to concrete handlers
 * using the agent's tool mapping from config.yml.
 */

import type { ToolProvider, ToolResult } from 'coil-runtime/sdk';
import type { ToolEntry } from '../loader/types.js';

export class SandboxToolProvider implements ToolProvider {
  constructor(
    /** agent name → abstract → concrete mapping */
    private agentTools: Record<string, string>,
    /** concrete path → handler */
    private toolRegistry: Map<string, ToolEntry>,
  ) {}

  async invoke(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    // tool is the abstract name from the COIL scenario
    const concretePath = this.agentTools[tool];
    if (!concretePath) {
      throw new Error(
        `Tool "${tool}" is not mapped for this agent. ` +
        `Available: ${Object.keys(this.agentTools).join(', ')}`,
      );
    }

    const entry = this.toolRegistry.get(concretePath);
    if (!entry) {
      throw new Error(`Tool implementation "${concretePath}" not found in backend.`);
    }

    const argKeys = Object.keys(args);
    console.log(`[tool] ${tool} → ${concretePath}${argKeys.length ? ` (${argKeys.join(', ')})` : ''}`);

    const result = await entry.handler(args);

    const preview = typeof result === 'string'
      ? result.slice(0, 120) + (result.length > 120 ? '…' : '')
      : JSON.stringify(result).slice(0, 120);
    console.log(`[tool] ${tool} ✓ ${preview}`);

    return { output: result };
  }
}
