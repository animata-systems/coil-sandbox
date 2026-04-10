/**
 * Protocol runner: executes a COIL scenario for an agent.
 *
 * Lifecycle:
 * 1. Message with @mention arrives → runner creates protocol instance
 * 2. Parse + validate .coil source
 * 3. Execute with providers, handling yield/resume cycle
 * 4. ПОЛУЧИ → inject triggering message as object
 * 5. НАПИШИ КОМУ @agent → detect mention, spawn child protocol
 * 6. НАПИШИ without addressee → reply to caller
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';

import {
  tokenize,
  parse,
  validate,
  execute,
  resume,
  loadDialect,
  KeywordIndex,
} from 'coil-runtime';

import type {
  ExecutionResult,
  YieldRequest,
  ExecutionSnapshot,
  Message,
} from 'coil-runtime/sdk';

import type { LoadedApp, AgentEntry } from '../loader/types.js';
import { detectDialect } from '../utils/detect-dialect.js';
import { SandboxModelProvider } from '../providers/model-provider.js';
import { SandboxToolProvider } from '../providers/tool-provider.js';
import { SandboxChannelProvider, shortId, type MessageEnvelope } from '../providers/channel-provider.js';
import { SandboxParticipantProvider } from '../providers/participant-provider.js';

export interface ProtocolContext {
  app: LoadedApp;
  channelProvider: SandboxChannelProvider;
  participantProvider: SandboxParticipantProvider;
  modelProvider: SandboxModelProvider;
  dialectPath: string;
  onLog: (agentName: string, message: string) => void;
  /** Root post that started the entire chain. All agent messages are comments on it. */
  rootPostId?: string;
  rootChannel?: string;
  /**
   * Block ПОЛУЧИ callback: show a prompt to the user and collect a response.
   * Called only when the protocol was triggered by @user.
   * Returns the user's answer (string).
   */
  onPromptUser?: (agentName: string, prompt: string) => Promise<string>;
  /** Called after an agent posts a message — allows Sandbox to detect mentions and spawn protocols. */
  onAgentMessage?: (envelope: MessageEnvelope, rootPostId: string, rootChannel: string) => void;
}

export async function runProtocol(
  agent: AgentEntry,
  triggerMessage: MessageEnvelope,
  ctx: ProtocolContext,
): Promise<void> {
  const { app, onLog } = ctx;

  // Determine root post: either inherited from parent context or this trigger is the root
  const rootPostId = ctx.rootPostId ?? triggerMessage.id;
  const rootChannel = ctx.rootChannel ?? triggerMessage.channel ?? 'general';

  onLog(agent.name, `Protocol started (triggered by ${triggerMessage.from})`);

  // -- Parse & validate ----------------------------------------

  // Hot-reload: re-read .coil source from disk so changes take effect immediately
  let freshSource: string;
  try {
    freshSource = await readFile(
      join(ctx.app.path, 'agents', `${agent.name}.coil`),
      'utf-8',
    );
    agent.source = freshSource;
  } catch {
    freshSource = agent.source;
  }

  // Determine dialect: @dialect annotation in source takes priority, otherwise default
  const detectedName = detectDialect(freshSource);
  const dialectPath = detectedName
    ? resolveDialectPath(detectedName)
    : ctx.dialectPath;
  const dialectTable = await loadDialect(dialectPath);
  const keywords = KeywordIndex.build(dialectTable);

  const tokens = tokenize(freshSource, keywords);
  const ast = parse(tokens, dialectTable, freshSource);

  const validation = validate(ast, dialectTable);
  const errors = validation.diagnostics.filter(d => d.severity === 'error');
  if (errors.length > 0) {
    for (const err of errors) {
      onLog(agent.name, `Validation error: ${err.message} (line ${err.span.line})`);
    }
    return;
  }

  // ── Providers for this agent ────────────────────────────

  const toolProvider = new SandboxToolProvider(
    agent.config.tools,
    app.tools,
  );

  const providers = {
    model: ctx.modelProvider,
    tool: toolProvider,
    participant: ctx.participantProvider,
    channel: createAgentChannelProxy(agent.name, triggerMessage, rootPostId, rootChannel, ctx),
  };

  // ── Execute with yield/resume loop ──────────────────────

  let result: ExecutionResult | YieldRequest = await execute(ast, providers);

  while (result.type === 'yield') {
    const yr = result as YieldRequest;
    onLog(agent.name, `Yield: ${yr.detail.type}`);

    if (yr.detail.type === 'receive') {
      const { variableName, prompt, timeoutMs } = yr.detail;

      if (prompt !== null) {
        // Block receive (with body-prompt): ask user for input or skip if agent-triggered
        if (triggerMessage.from === '@user' && ctx.onPromptUser) {
          onLog(agent.name, `Prompting user: ${prompt}`);

          let receiveValue: unknown;
          const PROMPT_TIMEOUT = Symbol('prompt-timeout');
          try {
            if (timeoutMs !== null && timeoutMs > 0) {
              // Race prompt against timeout; clear timer on success
              let timerId: ReturnType<typeof setTimeout>;
              const timer = new Promise<never>((_, reject) => {
                timerId = setTimeout(() => reject(PROMPT_TIMEOUT), timeoutMs);
              });
              try {
                receiveValue = await Promise.race([
                  ctx.onPromptUser(agent.name, prompt),
                  timer,
                ]);
              } finally {
                clearTimeout(timerId!);
              }
            } else {
              receiveValue = await ctx.onPromptUser(agent.name, prompt);
            }
          } catch (err) {
            if (err === PROMPT_TIMEOUT) {
              onLog(agent.name, `Block ПОЛУЧИ timed out: ${variableName}`);
              result = await resume(
                yr.snapshot,
                { type: 'Timeout' },
                ast,
                providers,
              );
              continue;
            }
            throw err;
          }

          result = await resume(
            yr.snapshot,
            { type: 'ReceiveValue', value: receiveValue as string },
            ast,
            providers,
          );
          continue;
        } else {
          // Agent-triggered protocol — agents can't respond to prompts
          onLog(agent.name, `Block ПОЛУЧИ skipped (not user-triggered): ${variableName}`);
          result = await resume(
            yr.snapshot,
            { type: 'ReceiveValue', value: '' },
            ast,
            providers,
          );
          continue;
        }
      }

      // Inline receive — route by variableName.
      // Built-in resources first (host contract), model aliases second (user config).
      let receiveValue: unknown;

      if (variableName === 'message') {
        // Trigger envelope as object so $message.body etc. work
        receiveValue = {
          body: typeof triggerMessage.body === 'string'
            ? triggerMessage.body
            : JSON.stringify(triggerMessage.body),
          from: triggerMessage.from,
          to: triggerMessage.to,
          channel: triggerMessage.channel ?? '',
          datetime: triggerMessage.datetime,
          replyTo: triggerMessage.replyTo ?? '',
        };
      } else if (variableName === 'thread') {
        // Thread: root post + all comments, chronologically
        receiveValue = ctx.channelProvider.getThread(rootPostId, rootChannel);
      } else if (variableName === 'participants') {
        // All participants (agents + user), excluding the current agent and system agents
        const list: Array<{ handle: string; description: string }> = [];
        list.push({ handle: '@user', description: 'Пользователь' });
        for (const [name, entry] of app.agents) {
          if (name === agent.name) continue;
          if (entry.config.system) continue;
          list.push({
            handle: `@${name}`,
            description: entry.config.description ?? '',
          });
        }
        receiveValue = list;
      } else if (variableName in app.config.models) {
        // Model alias → string value from config
        receiveValue = app.config.models[variableName];
      } else {
        onLog(agent.name, `Unknown resource for ПОЛУЧИ: ${variableName}`);
        break;
      }

      // ReceiveValue.value is typed as string in runtime SDK,
      // but executor does scope.set(name, value) — any type works at runtime.
      result = await resume(
        yr.snapshot,
        { type: 'ReceiveValue', value: receiveValue as unknown as string },
        ast,
        providers,
      );
    } else if (yr.detail.type === 'await-replies') {
      // НАПИШИ КОМУ @agent ЖДАТЬ → spawn child protocol, collect reply
      const reply = await handleAwaitReplies(yr, agent, rootPostId, rootChannel, ctx);
      result = await resume(yr.snapshot, reply, ast, providers);
    } else if (yr.detail.type === 'wait-promises') {
      // ЖДИ НА ?promise → check if promises are already resolved in snapshot
      const names: string[] = yr.detail.promiseNames;
      onLog(agent.name, `Waiting for: ${names.join(', ')}`);

      // After MessageReply, the executor marks the promise as resolved.
      // Send PromiseResolved for each resolved promise so executor can proceed.
      const firstResolved = names.find(
        n => yr.snapshot.promises[n]?.status === 'resolved',
      );

      if (firstResolved) {
        const entry = yr.snapshot.promises[firstResolved];
        result = await resume(
          yr.snapshot,
          { type: 'PromiseResolved', promiseName: firstResolved, result: entry.result },
          ast,
          providers,
        );
      } else {
        // Not yet resolved — timeout fallback
        result = await resume(
          yr.snapshot,
          { type: 'Timeout' },
          ast,
          providers,
        );
      }
    } else {
      onLog(agent.name, `Unhandled yield type: ${(yr.detail as { type: string }).type}`);
      break;
    }
  }

  // if (result.type === 'error') {
  //   onLog(agent.name, `Protocol error: ${(result as { message?: string }).message ?? 'unknown'}`);
  // } else {
    onLog(agent.name, 'Protocol completed');
  // }
}

// ── Helpers ─────────────────────────────────────────────────

/**
 * Creates a channel provider proxy that:
 * - Stamps `from` with the agent's name
 * - ALL messages are comments on the root post (the user's original message)
 * - Posts messages to the main channel provider for visibility and persistence
 */
function createAgentChannelProxy(
  agentName: string,
  triggerMessage: MessageEnvelope,
  rootPostId: string,
  rootChannel: string,
  ctx: ProtocolContext,
): SandboxChannelProvider {
  const proxy = new SandboxChannelProvider();

  proxy.deliver = async (channel, participantIds, payload) => {
    const isReply = participantIds.length === 0;
    const effectiveChannel = channel ?? rootChannel;
    const effectiveTo = isReply
      ? [triggerMessage.from]
      : participantIds;

    const msgId = shortId();

    const envelope: MessageEnvelope = {
      id: msgId,
      channel: effectiveChannel,
      from: `@${agentName}`,
      to: effectiveTo,
      body: payload,
      datetime: new Date().toISOString(),
      // Physical placement: all messages are comments on the root post
      commentOn: `#${rootChannel}/${rootPostId}`,
      // Semantic reference: anonymous НАПИШИ replies to the trigger message
      ...(isReply
        ? { replyTo: `#${triggerMessage.channel ?? rootChannel}/${triggerMessage.id}` }
        : {}),
    };

    // Post to main channel provider for visibility + persistence.
    // Await ensures message is persisted before triggering downstream protocols.
    await ctx.channelProvider.post(envelope);

    // Detect @mentions in agent's message and spawn new protocols
    ctx.onAgentMessage?.(envelope, rootPostId, rootChannel);

    // Register correlation so ЖДАТЬ can match replies by message id
    return { correlationId: msgId };
  };

  return proxy;
}

/**
 * Handle НАПИШИ КОМУ @agent1, @agent2 ЖДАТЬ:
 * 1. Find the outgoing message by correlationId (= message id)
 * 2. Detect ALL target agents from `to` field
 * 3. Spawn child protocol for each target agent
 * 4. Collect replies (any = first reply, all = all target agents replied)
 * 5. Return as MessageReply ResumeEvent
 */
async function handleAwaitReplies(
  yr: YieldRequest,
  parentAgent: AgentEntry,
  rootPostId: string,
  rootChannel: string,
  ctx: ProtocolContext,
) {
  const detail = yr.detail as {
    type: 'await-replies';
    correlationId: string;
    awaitPolicy: 'any' | 'all';
    promiseName: string;
  };

  const outgoingId = detail.correlationId;

  // Find the outgoing message to discover target agents
  const outgoing = ctx.channelProvider.findMessageById(outgoingId);
  const targetNames = (outgoing?.to ?? [])
    .map(t => t.replace(/^@/, ''))
    .filter(t => ctx.app.agents.has(t));

  const expectedCount = detail.awaitPolicy === 'any' ? 1 : Math.max(targetNames.length, 1);

  return new Promise<{ type: 'MessageReply'; correlationId: string; replies: Message[] }>(
    (resolveEvent) => {
      // Match by replyTo: child agent's anonymous НАПИШИ sets replyTo = outgoing message.
      // This is the semantic dimension (§9.3a) — "I'm responding to this specific message".
      // commentOn is the physical dimension — all point to root post.
      const replyTarget = `#${rootChannel}/${outgoingId}`;
      const replies: Message[] = [];

      const handler = (msg: MessageEnvelope) => {
        if (msg.replyTo === replyTarget) {
          replies.push({
            envelope: {
              from: msg.from,
              channel: msg.channel,
              datetime: msg.datetime,
            },
            payload: msg.body,
          });

          if (replies.length >= expectedCount) {
            ctx.channelProvider.removeListener('message', handler);
            resolveEvent({
              type: 'MessageReply',
              correlationId: outgoingId,
              replies,
            });
          }
        }
      };

      ctx.channelProvider.on('message', handler);

      // Spawn child protocols for all target agents
      if (outgoing) {
        const childCtx: ProtocolContext = {
          ...ctx,
          rootPostId,
          rootChannel,
        };
        for (const name of targetNames) {
          const agent = ctx.app.agents.get(name)!;
          const childTrigger: MessageEnvelope = {
            ...outgoing,
            // Child sees this as "the message that triggered me"
          };
          ctx.onLog(parentAgent.name, `Spawning @${name} protocol`);
          runProtocol(agent, childTrigger, childCtx).catch(err => {
            ctx.onLog(name, `Protocol error: ${err.message}`);
          });
        }
      }
    },
  );
}

// ── Dialect resolution ─────────────────────────────────────

const _require = createRequire(import.meta.url);

function resolveDialectPath(name: string): string {
  const coilPkg = dirname(_require.resolve('coil/package.json'));
  return join(coilPkg, 'dialects', name, `${name}.json`);
}

// ── Mention detection ───────────────────────────────────────

const MENTION_RE = /@(\w+)/g;

export function detectMentions(text: string): string[] {
  const mentions: string[] = [];
  let match;
  while ((match = MENTION_RE.exec(text)) !== null) {
    mentions.push(match[1]);
  }
  return mentions;
}
