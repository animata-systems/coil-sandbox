/** Loaded application structure. */

export interface AppConfig {
  models: Record<string, string>;           // alias → provider/model
  agents: Record<string, AgentConfig>;      // agent name → config
}

export interface AgentConfig {
  description?: string;                     // human-readable agent description
  tools: Record<string, string>;            // abstract name → package/tool
}

export interface ToolMeta {
  description: string;
  args: Record<string, ArgMeta>;
}

export interface ArgMeta {
  type: string;
  required?: boolean;
}

export interface ToolEntry {
  meta: ToolMeta;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface AgentEntry {
  name: string;
  source: string;                            // raw .coil source
  config: AgentConfig;
}

/** Message envelope persisted in storage. */
export interface StoredMessage {
  id?: string;
  datetime: string;
  to: string;
  from: string;
  /** Comment relation: #channel/postId — this message is a comment on that post. */
  commentOn?: string;
  /** Reply relation: #channel/postId/commentId — semantic reference. */
  replyTo?: string;
  body: string;
}

/** A thread loaded from a single storage file (post + comments). */
export interface ThreadSeed {
  file: string;                              // file path on disk
  messages: StoredMessage[];
}

export interface ChannelSeed {
  name: string;
  server: string;
  messages: StoredMessage[];
  threads: ThreadSeed[];
}

/** Complete loaded application. */
export interface LoadedApp {
  name: string;
  path: string;
  config: AppConfig;
  agents: Map<string, AgentEntry>;
  tools: Map<string, ToolEntry>;           // "package/tool" → entry
  channels: ChannelSeed[];
}
