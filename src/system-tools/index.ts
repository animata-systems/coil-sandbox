/**
 * System tools: built-in tools provided by the sandbox host.
 *
 * These tools are available to any agent via config mapping:
 *   tools:
 *     list_agents: system/list-agents
 *
 * They operate on the loaded app state and filesystem.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import type { ToolEntry, LoadedApp } from '../loader/types.js';
import type { SandboxParticipantProvider } from '../providers/participant-provider.js';

export interface SystemToolContext {
  app: LoadedApp;
  participantProvider: SandboxParticipantProvider;
  onAgentsChanged?: () => void;
}

/** Check if an agent has any system tool mappings (i.e. is a system agent). */
function hasSystemTools(app: LoadedApp, agentName: string): boolean {
  const agentConfig = app.config.agents[agentName];
  if (!agentConfig?.tools) return false;
  return Object.values(agentConfig.tools).some(path => path.startsWith('system/'));
}

export function createSystemTools(ctx: SystemToolContext): Map<string, ToolEntry> {
  const tools = new Map<string, ToolEntry>();

  // ── list-agents ────────────────────────────────────────────

  tools.set('system/list-agents', {
    meta: {
      description: 'Get list of all agents with their descriptions',
      args: {},
    },
    handler: async () => {
      const result: string[] = [];
      for (const [name] of ctx.app.agents) {
        const desc = ctx.app.config.agents[name]?.description ?? '';
        result.push(`- ${name}${desc ? ': ' + desc : ''}`);
      }
      return result.join('\n');
    },
  });

  // ── load-agent ─────────────────────────────────────────────

  tools.set('system/load-agent', {
    meta: {
      description: 'Load source code of a specific agent',
      args: {
        name: { type: 'string', required: true },
      },
    },
    handler: async (args) => {
      const name = args.name as string;
      const filePath = join(ctx.app.path, 'agents', `${name}.coil`);
      try {
        return await readFile(filePath, 'utf-8');
      } catch {
        return `[error] Agent "${name}" not found`;
      }
    },
  });

  // ── patch-agent ────────────────────────────────────────────

  tools.set('system/patch-agent', {
    meta: {
      description: 'Save agent source code and optional tool mappings (create new or overwrite existing)',
      args: {
        name: { type: 'string', required: true },
        source: { type: 'string', required: true },
        tools: { type: 'array', required: false },
      },
    },
    handler: async (args) => {
      const name = args.name as string;
      if (hasSystemTools(ctx.app, name)) {
        return `[error] Agent "${name}" is a system agent and cannot be modified`;
      }
      const source = args.source as string;
      const toolsResult = normalizeToolsMapping(args.tools);
      if ('error' in toolsResult) {
        return `[error] ${toolsResult.error}`;
      }
      const toolsMapping = toolsResult.mapping;
      const filePath = join(ctx.app.path, 'agents', `${name}.coil`);

      await mkdir(join(ctx.app.path, 'agents'), { recursive: true });
      await writeFile(filePath, source, 'utf-8');

      const existing = ctx.app.agents.get(name);
      if (existing) {
        existing.source = source;
        // Update tool mappings if provided
        if (Object.keys(toolsMapping).length > 0) {
          existing.config.tools = toolsMapping;
          ctx.app.config.agents[name].tools = toolsMapping;
          await updateConfigOnDisk(ctx.app.path, (config) => {
            if (config.agents?.[name]) {
              config.agents[name].tools = toolsMapping;
            }
          });
        }
      } else {
        // New agent: register in memory + config + participants
        const agentConfig = ctx.app.config.agents[name] ?? { tools: {} };
        if (Object.keys(toolsMapping).length > 0) {
          agentConfig.tools = toolsMapping;
        }
        ctx.app.config.agents[name] = agentConfig;
        await updateConfigOnDisk(ctx.app.path, (config) => {
          if (!config.agents) config.agents = {};
          config.agents[name] = { tools: agentConfig.tools };
        });
        ctx.app.agents.set(name, { name, source, config: agentConfig });
        ctx.participantProvider.registerAgent(name);
        ctx.onAgentsChanged?.();
      }

      return { success: true, agent: name };
    },
  });

  // ── update-agent-desc ──────────────────────────────────────

  tools.set('system/update-agent-desc', {
    meta: {
      description: 'Update agent description in application config',
      args: {
        name: { type: 'string', required: true },
        description: { type: 'string', required: true },
      },
    },
    handler: async (args) => {
      const name = args.name as string;
      if (hasSystemTools(ctx.app, name)) {
        return `[error] Agent "${name}" is a system agent and cannot be modified`;
      }
      const description = args.description as string;

      // Update in-memory config
      if (!ctx.app.config.agents[name]) {
        ctx.app.config.agents[name] = { tools: {} };
      }
      ctx.app.config.agents[name].description = description;

      // Persist to disk
      await updateConfigOnDisk(ctx.app.path, (config) => {
        if (!config.agents) config.agents = {};
        if (!config.agents[name]) config.agents[name] = {};
        config.agents[name].description = description;
      });

      return { success: true, agent: name, description };
    },
  });

  // ── load-skill ─────────────────────────────────────────────

  tools.set('system/load-skill', {
    meta: {
      description: 'Load a skill/reference file from the app skills directory',
      args: {
        name: { type: 'string', required: true },
      },
    },
    handler: async (args) => {
      const name = args.name as string;
      const filePath = join(ctx.app.path, 'skills', `${name}.md`);
      try {
        return await readFile(filePath, 'utf-8');
      } catch {
        return `[error] Skill "${name}" not found`;
      }
    },
  });

  // ── list-tools ─────────────────────────────────────────────

  tools.set('system/list-tools', {
    meta: {
      description: 'List all application tools with descriptions and arguments',
      args: {},
    },
    handler: async () => {
      const result: string[] = [];
      for (const [path, entry] of ctx.app.tools) {
        if (path.startsWith('system/')) continue;
        const args = Object.entries(entry.meta.args)
          .map(([name, a]) => `${name}: ${a.type}${a.required ? ' (required)' : ''}`)
          .join(', ');
        result.push(`- ${path}: ${entry.meta.description} [${args}]`);
      }
      return result.join('\n') || '(no application tools)';
    },
  });

  return tools;
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Normalize the `tools` argument of patch-agent into a Record<name, path>
 * for storage in config.yml.
 *
 * The contract is strict: tools is either omitted or a list of
 * `{ name, path }` objects. A COIL `РЕЗУЛЬТАТ` cannot express an object
 * with dynamic keys (ОБЪЕКТ requires fields declared up-front), so the
 * list form is the canonical shape. Any other shape — string, plain
 * object, scalar — is a structured-output failure and is surfaced as
 * an explicit error instead of silently mangling the config.
 */
function normalizeToolsMapping(
  raw: unknown,
): { mapping: Record<string, string> } | { error: string } {
  if (raw == null) {
    return { mapping: {} };
  }
  if (!Array.isArray(raw)) {
    return { error: 'tools must be a list of {name, path} objects (or omitted)' };
  }
  const mapping: Record<string, string> = {};
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object') {
      return { error: `tools[${i}] must be an object with "name" and "path"` };
    }
    const { name, path } = item as { name?: unknown; path?: unknown };
    if (typeof name !== 'string' || !name) {
      return { error: `tools[${i}].name must be a non-empty string` };
    }
    if (typeof path !== 'string' || !path) {
      return { error: `tools[${i}].path must be a non-empty string` };
    }
    if (name in mapping) {
      return { error: `tools[${i}].name "${name}" duplicates earlier entry` };
    }
    mapping[name] = path;
  }
  return { mapping };
}

async function updateConfigOnDisk(
  appPath: string,
  updater: (config: Record<string, any>) => void,
): Promise<void> {
  const configPath = join(appPath, 'config.yml');
  const raw = await readFile(configPath, 'utf-8');
  const config = parseYaml(raw) as Record<string, unknown>;
  updater(config);
  await writeFile(configPath, stringifyYaml(config), 'utf-8');
}
