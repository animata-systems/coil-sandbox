/**
 * Sandbox: top-level orchestrator.
 *
 * Ties together app loading, providers, protocol runner, and TUI.
 * Watches for user messages, detects mentions, spawns protocols.
 */

import { resolve } from 'node:path';
import type { LoadedApp } from '../loader/types.js';
import { loadApp } from '../loader/index.js';
import { SandboxModelProvider } from '../providers/model-provider.js';
import { SandboxChannelProvider, shortId, type MessageEnvelope } from '../providers/channel-provider.js';
import { SandboxParticipantProvider } from '../providers/participant-provider.js';
import { runProtocol, detectMentions, type ProtocolContext } from './protocol-runner.js';
import { createSystemTools } from '../system-tools/index.js';

export class Sandbox {
  private app: LoadedApp | null = null;
  private channelProvider = new SandboxChannelProvider();
  private participantProvider = new SandboxParticipantProvider();
  private modelProvider: SandboxModelProvider | null = null;
  private dialectPath: string;
  private onLog: (agent: string, msg: string) => void = () => {};

  constructor(dialectPath: string) {
    this.dialectPath = dialectPath;
  }

  /** Set log callback (TUI will provide this). */
  setLogger(fn: (agent: string, msg: string) => void): void {
    this.onLog = fn;
  }

  /** Load an application from disk. */
  async load(appPath: string): Promise<LoadedApp> {
    this.app = await loadApp(appPath);

    // Register participants
    this.participantProvider.registerUser('user');
    for (const name of this.app.agents.keys()) {
      this.participantProvider.registerAgent(name);
    }

    // Init model provider
    this.modelProvider = new SandboxModelProvider(this.app.config.models);

    // Register system tools (available via config mapping: system/tool-name)
    const systemTools = createSystemTools({
      app: this.app,
      participantProvider: this.participantProvider,
      onAgentsChanged: () => {
        this.channelProvider.emit('agents-changed', this.getAgentNames());
      },
    });
    for (const [key, entry] of systemTools) {
      this.app.tools.set(key, entry);
    }

    // Seed channels from storage and enable persistence
    this.channelProvider.seed(this.app.channels);
    this.channelProvider.setStoragePath(resolve(appPath, 'storage'));

    // Ensure at least #general
    this.channelProvider.ensureChannel('general');

    this.onLog('sandbox', `Loaded app "${this.app.name}": ${this.app.agents.size} agents, ${this.app.tools.size} tools`);

    return this.app;
  }

  /** Get channel provider (for TUI). */
  getChannels(): SandboxChannelProvider {
    return this.channelProvider;
  }

  /** Get loaded app info. */
  getApp(): LoadedApp | null {
    return this.app;
  }

  /** Get all messages in a channel. */
  getMessages(channel: string): MessageEnvelope[] {
    return this.channelProvider.getMessages(channel);
  }

  /** Get loaded agent names. */
  getAgentNames(): string[] {
    return this.app ? [...this.app.agents.keys()] : [];
  }

  /** List available servers. */
  async getServers(): Promise<string[]> {
    return this.channelProvider.getServers();
  }

  /** Get current server name. */
  getCurrentServer(): string {
    return this.channelProvider.getServerName();
  }

  /** Switch to a different server. */
  async switchServer(name: string): Promise<void> {
    await this.channelProvider.switchServer(name);
  }

  /** Create a new server. */
  async createServer(name: string): Promise<void> {
    await this.channelProvider.createServer(name);
  }

  /** Delete a server. */
  async deleteServer(name: string): Promise<void> {
    await this.channelProvider.deleteServer(name);
  }

  /** Create a new channel. */
  async createChannel(name: string): Promise<void> {
    await this.channelProvider.createChannel(name);
  }

  /** Delete a channel. */
  async deleteChannel(name: string): Promise<void> {
    await this.channelProvider.deleteChannel(name);
  }

  /** Handle a user message: post to channel + detect mentions → spawn protocols. */
  async handleUserMessage(channel: string, text: string, replyTo?: string): Promise<void> {
    if (!this.app || !this.modelProvider) {
      throw new Error('No app loaded');
    }

    const envelope: MessageEnvelope = {
      id: shortId(),
      channel,
      from: '@user',
      to: [],
      body: text,
      datetime: new Date().toISOString(),
      ...(replyTo ? { replyTo: `#${channel}/${replyTo}` } : {}),
    };

    // Post message to channel (persist first, then emit)
    await this.channelProvider.post(envelope);

    this.spawnMentionedProtocols(envelope);
  }

  /** Handle a user comment on a post: post with commentOn + detect mentions → spawn protocols. */
  async handleUserComment(channel: string, text: string, commentOnPostId: string, replyTo?: string): Promise<void> {
    if (!this.app || !this.modelProvider) {
      throw new Error('No app loaded');
    }

    const envelope: MessageEnvelope = {
      id: shortId(),
      channel,
      from: '@user',
      to: [],
      body: text,
      datetime: new Date().toISOString(),
      commentOn: `#${channel}/${commentOnPostId}`,
      ...(replyTo ? { replyTo: `#${channel}/${replyTo}` } : {}),
    };

    await this.channelProvider.post(envelope);

    this.spawnMentionedProtocols(envelope, commentOnPostId, channel);
  }

  /** Detect @mentions in a message and spawn agent protocols. */
  private spawnMentionedProtocols(
    envelope: MessageEnvelope,
    rootPostId?: string,
    rootChannel?: string,
  ): void {
    if (!this.app || !this.modelProvider) return;

    const text = typeof envelope.body === 'string' ? envelope.body : '';
    const mentions = detectMentions(text);

    for (const mention of mentions) {
      const agent = this.app.agents.get(mention);
      if (!agent) continue;

      const ctx: ProtocolContext = {
        app: this.app,
        channelProvider: this.channelProvider,
        participantProvider: this.participantProvider,
        modelProvider: this.modelProvider,
        dialectPath: this.dialectPath,
        onLog: this.onLog,
        rootPostId,
        rootChannel,
      };

      runProtocol(agent, envelope, ctx).catch(err => {
        this.onLog(mention, `Protocol error: ${err.message}`);
      });
    }
  }
}
