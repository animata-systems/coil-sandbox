// App loader: scans an application directory and produces LoadedApp.
//
// 1. Reads config.yml          -> models + agent tool mappings
// 2. Scans agents/{name}.coil  -> agent sources
// 3. Scans backend/{pkg}/list.yml + {pkg}/{tool}/index.js -> tool entries
// 4. Scans storage/            -> seed messages

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { pathToFileURL } from 'node:url';

import type {
  AppConfig,
  AgentEntry,
  ToolEntry,
  ToolMeta,
  ChannelSeed,
  ThreadSeed,
  StoredMessage,
  LoadedApp,
} from './types.js';

// -- Config -------------------------------------------------

async function loadConfig(appPath: string): Promise<AppConfig> {
  const raw = await readFile(join(appPath, 'config.yml'), 'utf-8');
  const parsed = parseYaml(raw) as Record<string, unknown>;

  const models = (parsed.models ?? {}) as Record<string, string>;
  const agentsRaw = (parsed.agents ?? {}) as Record<string, {
    description?: string;
    tools?: Record<string, string>;
  }>;

  const agents: AppConfig['agents'] = {};
  for (const [name, cfg] of Object.entries(agentsRaw)) {
    agents[name] = {
      ...(cfg.description ? { description: cfg.description } : {}),
      tools: cfg.tools ?? {},
    };
  }

  return { models, agents };
}

// -- Agents -------------------------------------------------

async function loadAgents(
  appPath: string,
  config: AppConfig,
): Promise<Map<string, AgentEntry>> {
  const agentsDir = join(appPath, 'agents');
  const agents = new Map<string, AgentEntry>();

  let files: string[];
  try {
    files = await readdir(agentsDir);
  } catch {
    return agents;
  }

  for (const file of files) {
    if (!file.endsWith('.coil')) continue;
    const name = basename(file, '.coil');
    const source = await readFile(join(agentsDir, file), 'utf-8');
    const agentConfig = config.agents[name] ?? { tools: {} };
    agents.set(name, { name, source, config: agentConfig });
  }

  return agents;
}

// -- Tools --------------------------------------------------

async function loadTools(appPath: string): Promise<Map<string, ToolEntry>> {
  const backendDir = join(appPath, 'backend');
  const tools = new Map<string, ToolEntry>();

  let packages: string[];
  try {
    packages = await readdir(backendDir);
  } catch {
    return tools;
  }

  for (const pkg of packages) {
    const pkgPath = join(backendDir, pkg);
    const pkgStat = await stat(pkgPath);
    if (!pkgStat.isDirectory()) continue;

    // Read list.yml
    let listRaw: string;
    try {
      listRaw = await readFile(join(pkgPath, 'list.yml'), 'utf-8');
    } catch {
      continue;
    }

    const list = parseYaml(listRaw) as { tools?: Record<string, ToolMeta> };
    if (!list.tools) continue;

    for (const [toolName, meta] of Object.entries(list.tools)) {
      const handlerPath = join(pkgPath, toolName, 'index.js');
      const handlerUrl = pathToFileURL(resolve(handlerPath)).href;

      try {
        const mod = await import(handlerUrl);
        const handler = mod.default as (args: Record<string, unknown>) => Promise<unknown>;
        tools.set(`${pkg}/${toolName}`, { meta, handler });
      } catch (err) {
        console.error(`[loader] Failed to load tool ${pkg}/${toolName}: ${err}`);
      }
    }
  }

  return tools;
}

// -- Storage (seed data) ------------------------------------

function parseMessages(raw: string): StoredMessage[] {
  // Split on `---` that sits alone on a line (no indentation).
  // Body lines are always indented with 2 spaces, so `  ---` won't match.
  const docs = raw.split(/^---$/m).map(s => s.trim()).filter(Boolean);
  const messages: StoredMessage[] = [];

  for (const doc of docs) {
    const lines = doc.split('\n');
    const msg: Partial<StoredMessage> = {};
    let inBody = false;
    let bodyLines: string[] = [];

    for (const line of lines) {
      if (inBody) {
        bodyLines.push(line.startsWith('  ') ? line.slice(2) : line);
        continue;
      }
      if (line.startsWith('DATETIME:')) {
        msg.datetime = line.slice('DATETIME:'.length).trim();
      } else if (line.startsWith('ID:')) {
        msg.id = line.slice('ID:'.length).trim();
      } else if (line.startsWith('TO:')) {
        msg.to = line.slice('TO:'.length).trim();
      } else if (line.startsWith('FROM:')) {
        msg.from = line.slice('FROM:'.length).trim();
      } else if (line.startsWith('COMMENT-ON:')) {
        msg.commentOn = line.slice('COMMENT-ON:'.length).trim();
      } else if (line.startsWith('REPLY-TO:')) {
        msg.replyTo = line.slice('REPLY-TO:'.length).trim();
      } else if (line.startsWith('BODY:')) {
        inBody = true;
      }
    }

    if (msg.datetime && msg.from) {
      msg.body = bodyLines.join('\n').trim();
      messages.push(msg as StoredMessage);
    }
  }

  return messages;
}

async function loadStorage(appPath: string): Promise<ChannelSeed[]> {
  const storageDir = join(appPath, 'storage');
  const channels: ChannelSeed[] = [];

  let servers: string[];
  try {
    servers = await readdir(storageDir);
  } catch {
    return channels;
  }

  for (const server of servers) {
    const serverPath = join(storageDir, server);
    const serverStat = await stat(serverPath);
    if (!serverStat.isDirectory()) continue;

    let channelNames: string[];
    try {
      channelNames = await readdir(serverPath);
    } catch {
      continue;
    }

    for (const channelName of channelNames) {
      const channelPath = join(serverPath, channelName);
      const channelStat = await stat(channelPath);
      if (!channelStat.isDirectory()) continue;

      const messages: StoredMessage[] = [];
      const threads: ThreadSeed[] = [];

      const files = await readdir(channelPath);
      for (const file of files.sort()) {
        if (!file.endsWith('.txt')) continue;
        const filePath = join(channelPath, file);
        const raw = await readFile(filePath, 'utf-8');
        const parsed = parseMessages(raw);
        messages.push(...parsed);
        threads.push({ file: filePath, messages: parsed });
      }

      channels.push({ name: channelName, server, messages, threads });
    }
  }

  return channels;
}

// -- Public API ---------------------------------------------

export async function loadApp(appPath: string): Promise<LoadedApp> {
  const absPath = resolve(appPath);
  const name = basename(absPath);

  const config = await loadConfig(absPath);
  const [agents, tools, channels] = await Promise.all([
    loadAgents(absPath, config),
    loadTools(absPath),
    loadStorage(absPath),
  ]);

  // Validate: every tool mapping in config points to loaded tool
  for (const [agentName, agentCfg] of Object.entries(config.agents)) {
    for (const [abstractName, concretePath] of Object.entries(agentCfg.tools)) {
      if (!tools.has(concretePath) && !concretePath.startsWith('system/')) {
        console.error(
          `[loader] Agent "${agentName}": tool "${abstractName}" → "${concretePath}" not found`,
        );
      }
    }
  }

  return { name, path: absPath, config, agents, tools, channels };
}
