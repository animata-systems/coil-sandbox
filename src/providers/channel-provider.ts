/**
 * ChannelProvider: in-memory message space.
 *
 * Manages channels, message delivery, and persistence.
 * Emits events so TUI can render messages in real time.
 */

import { EventEmitter } from 'node:events';
import { appendFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChannelProvider } from 'coil-runtime/sdk';
import type { StoredMessage, ChannelSeed } from '../loader/types.js';

let idCounter = 0;
export function shortId(): string {
  return (++idCounter).toString(36).padStart(4, '0');
}

export interface MessageEnvelope {
  id: string;
  channel: string | null;
  from: string;
  to: string[];
  body: string | Record<string, unknown>;
  datetime: string;
  /** Comment relation: #channel/postId — physical placement (this message is a comment on that post). */
  commentOn?: string;
  /** Reply relation: #channel/postId/commentId — semantic reference (this message is in response to that message). */
  replyTo?: string;
}

export class SandboxChannelProvider extends EventEmitter implements ChannelProvider {
  private channels = new Map<string, MessageEnvelope[]>();
  private correlationMap = new Map<string, {
    promiseName: string;
    awaitPolicy: 'any' | 'all';
    replies: MessageEnvelope[];
  }>();

  /** Base path for storage persistence (e.g. apps/story-workshop/storage). */
  private storagePath: string | null = null;
  private storageServer = 'main';

  /** Maps message id → file path on disk (for threading: replies append to same file). */
  private messageFileMap = new Map<string, string>();

  /** Sequential write queue — ensures messages are persisted in order. */
  private writeQueue: Promise<void> = Promise.resolve();

  /** Enable persistence: all new messages will be appended to storage files. */
  setStoragePath(storagePath: string, server = 'main'): void {
    this.storagePath = storagePath;
    this.storageServer = server;
  }

  /** Load seed messages from storage. Only loads channels for the current server. */
  seed(seeds: ChannelSeed[]): void {
    for (const ch of seeds) {
      // Only load channels belonging to the current server
      if (ch.server !== this.storageServer) continue;

      const messages: MessageEnvelope[] = ch.messages.map((m) => ({
        id: m.id ?? shortId(),
        channel: ch.name,
        from: m.from,
        to: m.to ? [m.to] : [],
        body: m.body,
        datetime: m.datetime,
        commentOn: m.commentOn,
        replyTo: m.replyTo,
      }));
      this.channels.set(ch.name, messages);

      // Restore messageFileMap so new comments append to correct thread files.
      // Also advance idCounter past any loaded IDs to avoid collisions.
      for (const thread of ch.threads) {
        for (const m of thread.messages) {
          if (m.id) {
            this.messageFileMap.set(m.id, thread.file);
            const num = parseInt(m.id, 36);
            if (!isNaN(num) && num >= idCounter) {
              idCounter = num;
            }
          }
        }
      }
    }
  }

  /** Get all messages in a channel. */
  getMessages(channel: string): MessageEnvelope[] {
    return this.channels.get(channel) ?? [];
  }

  /** Get all known channel names. */
  getChannelNames(): string[] {
    return [...this.channels.keys()];
  }

  /** Get current storage server name. */
  getServerName(): string {
    return this.storageServer;
  }

  /** Get the storage base path. */
  getStoragePath(): string | null {
    return this.storagePath;
  }

  /** List available servers (directories under storage/). */
  async getServers(): Promise<string[]> {
    if (!this.storagePath) return [this.storageServer];
    try {
      const entries = await readdir(this.storagePath, { withFileTypes: true });
      return entries.filter(e => e.isDirectory()).map(e => e.name);
    } catch {
      return [this.storageServer];
    }
  }

  /** Switch to a different server. Clears in-memory channels, reloads from disk. */
  async switchServer(name: string): Promise<void> {
    this.storageServer = name;
    this.channels.clear();
    this.messageFileMap.clear();

    if (this.storagePath) {
      const serverDir = join(this.storagePath, name);
      await mkdir(serverDir, { recursive: true });

      // Load channels from disk
      try {
        const entries = await readdir(serverDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const channelDir = join(serverDir, entry.name);
          const messages: MessageEnvelope[] = [];

          const files = (await readdir(channelDir)).filter(f => f.endsWith('.txt')).sort();
          for (const file of files) {
            const filePath = join(channelDir, file);
            const raw = await readFile(filePath, 'utf-8');
            const parsed = this.parseStorageFile(raw, entry.name);
            for (const msg of parsed) {
              this.messageFileMap.set(msg.id, filePath);
              const num = parseInt(msg.id, 36);
              if (!isNaN(num) && num >= idCounter) idCounter = num;
            }
            messages.push(...parsed);
          }

          this.channels.set(entry.name, messages);
        }
      } catch {
        // No channels yet — that's fine
      }
    }

    this.emit('server-switched', name);
  }

  /** Parse a storage file into MessageEnvelopes. */
  private parseStorageFile(raw: string, channel: string): MessageEnvelope[] {
    const docs = raw.split(/^---$/m).map(s => s.trim()).filter(Boolean);
    const messages: MessageEnvelope[] = [];

    for (const doc of docs) {
      const lines = doc.split('\n');
      const fields: Record<string, string> = {};
      let inBody = false;
      const bodyLines: string[] = [];

      for (const line of lines) {
        if (inBody) {
          bodyLines.push(line.startsWith('  ') ? line.slice(2) : line);
          continue;
        }
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;
        const key = line.slice(0, colonIdx).trim();
        const val = line.slice(colonIdx + 1).trim();
        if (key === 'BODY') { inBody = true; continue; }
        fields[key] = val;
      }

      if (fields['DATETIME'] && fields['FROM']) {
        messages.push({
          id: fields['ID'] ?? shortId(),
          channel,
          from: fields['FROM'],
          to: fields['TO'] ? [fields['TO']] : [],
          body: bodyLines.join('\n').trim(),
          datetime: fields['DATETIME'],
          commentOn: fields['COMMENT-ON'],
          replyTo: fields['REPLY-TO'],
        });
      }
    }

    return messages;
  }

  /** Create a new server (directory under storage/). */
  async createServer(name: string): Promise<void> {
    if (!this.storagePath) return;
    await mkdir(join(this.storagePath, name), { recursive: true });
    this.emit('server-created', name);
  }

  /** Delete a server and all its channels from disk. */
  async deleteServer(name: string): Promise<void> {
    if (!this.storagePath) return;
    const dir = join(this.storagePath, name);
    await rm(dir, { recursive: true, force: true });
    // If we deleted the current server, clear channels
    if (name === this.storageServer) {
      this.channels.clear();
      this.messageFileMap.clear();
    }
    this.emit('server-deleted', name);
  }

  /** Create a channel if it doesn't exist. */
  ensureChannel(name: string): void {
    if (!this.channels.has(name)) {
      this.channels.set(name, []);
      this.emit('channel-created', name);
    }
  }

  /** Create a new channel (in-memory + on disk). */
  async createChannel(name: string): Promise<void> {
    this.ensureChannel(name);
    if (this.storagePath) {
      await mkdir(join(this.storagePath, this.storageServer, name), { recursive: true });
    }
  }

  /** Delete a channel (in-memory + from disk). */
  async deleteChannel(name: string): Promise<void> {
    this.channels.delete(name);
    // Remove message file mappings for this channel
    for (const [id, file] of this.messageFileMap) {
      if (file.includes(`/${name}/`)) {
        this.messageFileMap.delete(id);
      }
    }
    if (this.storagePath) {
      const dir = join(this.storagePath, this.storageServer, name);
      await rm(dir, { recursive: true, force: true });
    }
    this.emit('channel-deleted', name);
  }

  /** Post a message directly (from user or system). */
  async post(envelope: MessageEnvelope): Promise<void> {
    const channel = envelope.channel ?? 'general';
    this.ensureChannel(channel);
    this.channels.get(channel)!.push(envelope);
    await this.persistMessage(channel, envelope);
    this.emit('message', envelope);
  }

  /** Deliver a reply to a correlated message. */
  async postReply(correlationId: string, reply: MessageEnvelope): Promise<void> {
    const entry = this.correlationMap.get(correlationId);
    if (entry) {
      entry.replies.push(reply);
    }
    // Also post to channel for visibility
    if (reply.channel) {
      this.ensureChannel(reply.channel);
      this.channels.get(reply.channel)!.push(reply);
      await this.persistMessage(reply.channel, reply);
    }
    this.emit('message', reply);
  }

  /** Get pending correlation entry. */
  getCorrelation(correlationId: string) {
    return this.correlationMap.get(correlationId);
  }

  /** Get thread: root post + all comments, sorted chronologically. */
  getThread(rootPostId: string, channel: string): Array<{
    body: string;
    from: string;
    to: string[];
    channel: string;
    datetime: string;
    replyTo: string;
  }> {
    const messages = this.channels.get(channel) ?? [];
    const commentRef = `#${channel}/${rootPostId}`;

    return messages
      .filter(m => m.id === rootPostId || m.commentOn === commentRef)
      .sort((a, b) => a.datetime.localeCompare(b.datetime))
      .map(m => ({
        body: typeof m.body === 'string' ? m.body : JSON.stringify(m.body),
        from: m.from,
        to: m.to,
        channel: m.channel ?? channel,
        datetime: m.datetime,
        replyTo: m.replyTo ?? '',
      }));
  }

  /** Find a message by id across all channels. */
  findMessageById(id: string): MessageEnvelope | undefined {
    for (const msgs of this.channels.values()) {
      const found = msgs.find(m => m.id === id);
      if (found) return found;
    }
    return undefined;
  }

  // -- Persistence --------------------------------------------

  /**
   * Persist a message to disk.
   *
   * Thread model: one file = one thread (post + comments).
   * - New post (no commentOn) → creates a new file named by post id.
   * - Comment (has commentOn = #channel/postId) → appends to post's file.
   * - replyTo is persisted as REPLY-TO header but does NOT affect file placement.
   * Messages within a file are separated by `---`.
   */
  private persistMessage(channel: string, envelope: MessageEnvelope): Promise<void> {
    if (!this.storagePath) return Promise.resolve();

    const dir = join(this.storagePath, this.storageServer, channel);

    let threadFile: string | undefined;

    // Comment → find the post's thread file
    if (envelope.commentOn) {
      const postId = this.parsePostId(envelope.commentOn);
      if (postId) {
        threadFile = this.messageFileMap.get(postId);
      }
    }

    // New post → create new thread file
    if (!threadFile) {
      const d = new Date(envelope.datetime);
      const dt = [
        String(d.getFullYear()),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0'),
        '-',
        String(d.getHours()).padStart(2, '0'),
        String(d.getMinutes()).padStart(2, '0'),
      ].join('');
      threadFile = join(dir, `${dt}-${envelope.id}.txt`);
    }

    // Register for future comments
    this.messageFileMap.set(envelope.id, threadFile);

    const block = this.formatBlock(channel, envelope);
    const finalFile = threadFile;

    // Sequential write: each write waits for the previous one
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dir, { recursive: true });
      await appendFile(finalFile, block);
    }).catch(() => {});

    return this.writeQueue;
  }

  /** Extract post id from comment address: #channel/postId → postId */
  private parsePostId(commentOn: string): string | null {
    // Format: #channel/postId or just postId
    const parts = commentOn.replace(/^#/, '').split('/');
    return parts.length >= 2 ? parts[1] : parts[0] || null;
  }

  private formatBlock(channel: string, envelope: MessageEnvelope): string {
    const to = Array.isArray(envelope.to) && envelope.to.length > 0
      ? envelope.to.join(', ')
      : '';
    const body = typeof envelope.body === 'string'
      ? envelope.body
      : JSON.stringify(envelope.body, null, 2);

    const lines = [
      `DATETIME: ${envelope.datetime}`,
      `ID: ${envelope.id}`,
      ...(to ? [`TO: ${to}`] : []),
      `FROM: ${envelope.from}`,
      ...(envelope.commentOn ? [`COMMENT-ON: ${envelope.commentOn}`] : []),
      ...(envelope.replyTo ? [`REPLY-TO: ${envelope.replyTo}`] : []),
      `BODY: |`,
      ...body.split('\n').map(l => `  ${l}`),
      '---',
      '',
    ];

    return lines.join('\n');
  }

  // -- ChannelProvider interface ------------------------------

  async deliver(
    channel: string | null,
    participantIds: string[],
    payload: string | Record<string, unknown>,
  ): Promise<{ correlationId: string }> {
    const id = shortId();
    const datetime = new Date().toISOString();

    const envelope: MessageEnvelope = {
      id,
      channel,
      from: '', // filled by engine with current agent name
      to: participantIds,
      body: payload,
      datetime,
    };

    if (channel) {
      this.ensureChannel(channel);
      this.channels.get(channel)!.push(envelope);
    }

    this.emit('message', envelope);

    return { correlationId: id };
  }
}
