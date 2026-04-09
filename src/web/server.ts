/**
 * Web UI server: Express + Socket.io.
 *
 * Replaces the old blessed TUI with a browser-based interface.
 * Serves static HTML and provides real-time message updates via Socket.io.
 */

import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import type { Sandbox } from '../engine/sandbox.js';
import type { MessageEnvelope } from '../providers/channel-provider.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolve public/ dir — works both in dev (src/web/) and prod (dist/src/web/). */
function resolvePublicDir(): string {
  const local = resolve(__dirname, 'public');
  if (existsSync(local)) return local;
  // prod: __dirname = dist/src/web → go up to project root, then src/web/public
  return resolve(__dirname, '../../../src/web/public');
}

export async function createWebUI(sandbox: Sandbox, port = Number(process.env.PORT) || 3000): Promise<void> {
  const app = express();
  const httpServer = createServer(app);
  const io = new SocketIOServer(httpServer);

  const channels = sandbox.getChannels();

  // Serve static files
  app.use(express.static(resolvePublicDir()));

  // Socket.io event handling
  io.on('connection', async (socket) => {
    // Send initial state
    const channelNames = channels.getChannelNames();
    const allMessages: Record<string, MessageEnvelope[]> = {};
    for (const name of channelNames) {
      allMessages[name] = channels.getMessages(name);
    }

    const servers = await sandbox.getServers();

    socket.emit('init', {
      channels: channelNames,
      messages: allMessages,
      agents: sandbox.getAgentNames(),
      servers,
      currentServer: sandbox.getCurrentServer(),
    });

    // Handle new post from user
    socket.on('post', async (data: { channel: string; text: string; replyTo?: string }) => {
      try {
        await sandbox.handleUserMessage(data.channel, data.text, data.replyTo);
      } catch (err) {
        socket.emit('error', { message: (err as Error).message });
      }
    });

    // Handle new comment from user
    socket.on('comment', async (data: { channel: string; text: string; commentOn: string; replyTo?: string }) => {
      try {
        await sandbox.handleUserComment(data.channel, data.text, data.commentOn, data.replyTo);
      } catch (err) {
        socket.emit('error', { message: (err as Error).message });
      }
    });

    // ── Server management ─────────────────────────
    socket.on('switch-server', async (name: string) => {
      try {
        await sandbox.switchServer(name);
        // Re-send channel list for the new server
        const newChannels = channels.getChannelNames();
        const msgs: Record<string, MessageEnvelope[]> = {};
        for (const ch of newChannels) {
          msgs[ch] = channels.getMessages(ch);
        }
        io.emit('server-switched', { server: name, channels: newChannels, messages: msgs });
      } catch (err) {
        socket.emit('error', { message: (err as Error).message });
      }
    });

    socket.on('create-server', async (name: string) => {
      try {
        await sandbox.createServer(name);
        const servers = await sandbox.getServers();
        io.emit('servers-updated', servers);
      } catch (err) {
        socket.emit('error', { message: (err as Error).message });
      }
    });

    socket.on('delete-server', async (name: string) => {
      try {
        await sandbox.deleteServer(name);
        const servers = await sandbox.getServers();
        io.emit('servers-updated', servers);
      } catch (err) {
        socket.emit('error', { message: (err as Error).message });
      }
    });

    // ── Channel management ────────────────────────
    socket.on('create-channel', async (name: string) => {
      try {
        await sandbox.createChannel(name);
      } catch (err) {
        socket.emit('error', { message: (err as Error).message });
      }
    });

    socket.on('delete-channel', async (name: string) => {
      try {
        await sandbox.deleteChannel(name);
        io.emit('channel-deleted', name);
      } catch (err) {
        socket.emit('error', { message: (err as Error).message });
      }
    });

    // ── Agent source (read-only) ──────────────────
    // Contract: client emits 'get-agent-source' with an agent name and an ack
    // callback. Server responds via the callback with either { source } on
    // success or { error } if the agent is not loaded. The source text comes
    // from AgentEntry.source (already in memory — no disk I/O). Used by the
    // React agent viewer island (see coil-sandbox/DESIGN.md S-0001).
    socket.on(
      'get-agent-source',
      (
        agentName: string,
        ack: (response: { source: string } | { error: string }) => void,
      ) => {
        if (typeof ack !== 'function') return;
        const entry = sandbox.getAgent(agentName);
        if (!entry) {
          ack({ error: 'agent not found' });
          return;
        }
        ack({ source: entry.source });
      },
    );
  });

  // Forward channel events to all connected clients
  channels.on('message', (msg: MessageEnvelope) => {
    io.emit('message', msg);
  });

  channels.on('channel-created', (name: string) => {
    io.emit('channel-created', name);
  });

  channels.on('agents-changed', (names: string[]) => {
    io.emit('agents-changed', names);
  });

  // Forward protocol logs
  sandbox.setLogger((agent: string, msg: string) => {
    io.emit('log', { agent, message: msg });
  });

  // Start server
  return new Promise<void>((resolvePromise) => {
    httpServer.listen(port, () => {
      console.log(`COIL Sandbox → http://localhost:${port}`);
      resolvePromise();
    });
  });
}
