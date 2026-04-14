/**
 * ModelProvider: routes ДУМАЙ calls to LLM via Vercel AI SDK.
 *
 * Uses ai-sdk for unified access to OpenAI, Anthropic, Google, etc.
 * Resolves model alias (e.g. "fast") → URI (e.g. "llm://openai/gpt-5.4-nano")
 * using the models map from config.yml.
 *
 * URI format: llm://provider/model-id?params
 *   - scheme:   llm:// (required)
 *   - host:     provider name (openai, anthropic, …)
 *   - path:     model identifier (/gpt-5.4, /claude-sonnet-4-5-20250514, …)
 *   - query:    reasoning=none|low|medium|high
 */

import { generateText, generateObject, Output, tool, stepCountIs } from 'ai';
import type { LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { z } from 'zod';
import type { ModelProvider, ModelCallConfig, ModelResult } from 'coil-runtime/sdk';
import type { ToolEntry, ToolMeta, ArgMeta } from '../loader/types.js';

// ResultSchemaField is not re-exported from coil-runtime/sdk,
// so we extract it from ModelCallConfig.resultSchema.
type ResultSchemaField = NonNullable<ModelCallConfig['resultSchema']>[number];
type ResultSchema = ResultSchemaField['schema'];

type ProviderFactory = ReturnType<typeof createOpenAI> | ReturnType<typeof createAnthropic>;

interface ParsedModelUri {
  provider: string;
  modelId: string;
  params: URLSearchParams;
}

/** Resolved model + prompt ready for an AI SDK call. */
interface ResolvedCall {
  model: LanguageModel;
  system: string | undefined;
  prompt: string;
  providerOptions: Record<string, Record<string, string>> | undefined;
  logSpec: string;
}

/** Parse `llm://provider/model-id?params` into components. */
function parseModelUri(uri: string): ParsedModelUri {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error(
      `Invalid model URI: "${uri}". Expected format: llm://provider/model-id`,
    );
  }

  if (url.protocol !== 'llm:') {
    throw new Error(
      `Invalid model URI scheme: "${url.protocol}" in "${uri}". Expected "llm:".`,
    );
  }

  const provider = url.hostname;
  const modelId = url.pathname.slice(1); // strip leading "/"

  if (!provider) {
    throw new Error(
      `Missing provider in model URI: "${uri}". Expected format: llm://provider/model-id`,
    );
  }
  if (!modelId) {
    throw new Error(
      `Missing model ID in model URI: "${uri}". Expected format: llm://provider/model-id`,
    );
  }

  return { provider, modelId, params: url.searchParams };
}

/** Build AI SDK providerOptions from URI query params. */
function buildProviderOptions(
  providerName: string,
  params: URLSearchParams,
): Record<string, Record<string, string>> | undefined {
  const reasoning = params.get('reasoning');
  if (!reasoning) return undefined;

  if (providerName === 'openai') {
    return { openai: { reasoningEffort: reasoning } };
  }

  return { [providerName]: { reasoning } };
}

export class SandboxModelProvider implements ModelProvider {
  private models: Record<string, string>;   // alias → llm:// URI
  private providers = new Map<string, ProviderFactory>();

  constructor(models: Record<string, string>) {
    this.models = models;
    // Validate all URIs early — fail at startup, not at call time
    for (const [alias, uri] of Object.entries(models)) {
      try {
        parseModelUri(uri);
      } catch (err) {
        throw new Error(`Model "${alias}": ${(err as Error).message}`);
      }
    }
    this.initProviders();
  }

  private initProviders(): void {
    const needed = new Set<string>();
    for (const uri of Object.values(this.models)) {
      needed.add(parseModelUri(uri).provider);
    }
    for (const name of needed) {
      this.ensureProvider(name);
    }
  }

  /** Lazily create a provider factory if API key is available. */
  private ensureProvider(name: string): void {
    if (this.providers.has(name)) return;
    if (name === 'openai' && process.env.OPENAI_API_KEY) {
      this.providers.set('openai', createOpenAI({ apiKey: process.env.OPENAI_API_KEY }));
    } else if (name === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
      this.providers.set('anthropic', createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));
    }
  }

  /** Resolve model, build system prompt, prepare everything for an AI SDK call. */
  private resolveCall(config: ModelCallConfig): ResolvedCall {
    const modelUri = config.via ?? Object.values(this.models)[0];
    if (!modelUri) {
      throw new Error('No model configured. Add models to config.yml.');
    }

    const { provider: providerName, modelId, params } = parseModelUri(modelUri);

    this.ensureProvider(providerName);
    const providerFactory = this.providers.get(providerName);
    if (!providerFactory) {
      throw new Error(
        `Provider "${providerName}" not configured. Set ${providerName.toUpperCase()}_API_KEY.`,
      );
    }

    const model = providerFactory(modelId);
    const providerOptions = buildProviderOptions(providerName, params);
    const logSpec = `${providerName}/${modelId}`;

    // Build system prompt from COIL config
    const systemParts: string[] = [];
    if (config.as.length > 0) {
      systemParts.push(...config.as);
    }
    if (config.goal) {
      systemParts.push(`Goal: ${config.goal}`);
    }
    if (config.context) {
      systemParts.push(`Context:\n${config.context}`);
    }
    const system = systemParts.join('\n\n') || undefined;
    const prompt = config.input ?? config.body ?? '';

    return { model, system, prompt, providerOptions, logSpec };
  }

  async call(config: ModelCallConfig): Promise<ModelResult> {
    const { model, system, prompt, providerOptions, logSpec } = this.resolveCall(config);
    const promptLen = (system?.length ?? 0) + prompt.length;

    // If РЕЗУЛЬТАТ is defined, use generateObject for structured output
    if (config.resultSchema && config.resultSchema.length > 0) {
      const schema = buildZodSchema(config.resultSchema);
      const fields = config.resultSchema.map(f => f.name).join(', ');
      console.log(`[model] generateObject → ${logSpec} | fields: {${fields}} | prompt: ${promptLen} chars`);

      try {
        const result = await generateObject({
          model,
          system,
          prompt,
          schema,
          ...(providerOptions ? { providerOptions } : {}),
        });

        const tokens = result.usage?.totalTokens;
        console.log(`[model] generateObject ✓ ${tokens != null ? `(${tokens} tokens)` : ''}`);

        return {
          output: result.object,
          usage: tokens != null ? { tokens } : undefined,
        };
      } catch (err) {
        console.error(`[model] generateObject ✗ ${(err as Error).message}`);
        throw err;
      }
    }

    // Otherwise, plain text generation
    console.log(`[model] generateText → ${logSpec} | prompt: ${promptLen} chars`);

    try {
      const result = await generateText({
        model,
        system,
        prompt,
        ...(providerOptions ? { providerOptions } : {}),
      });

      const tokens = result.usage?.totalTokens;
      console.log(`[model] generateText ✓ ${tokens != null ? `(${tokens} tokens)` : ''}`);

      return {
        output: result.text,
        usage: tokens != null ? { tokens } : undefined,
      };
    } catch (err) {
      console.error(`[model] generateText ✗ ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Call a model with tools available for LLM-driven invocation.
   *
   * Uses generateText with tools + experimental_output (Output.object) when
   * structured output is needed. AI SDK handles the full cycle: tool calls,
   * result injection, and structured output extraction in a single call.
   */
  async callWithTools(
    config: ModelCallConfig,
    resolvedTools: Map<string, ToolEntry>,
  ): Promise<ModelResult> {
    const { model, system, prompt, providerOptions, logSpec } = this.resolveCall(config);

    // Build AI SDK tools from resolved ToolEntry metadata + handlers
    const aiTools: Record<string, any> = {};
    for (const [abstractName, entry] of resolvedTools) {
      const inputSchema = argMetaToZod(entry.meta.args);
      aiTools[abstractName] = tool({
        description: entry.meta.description,
        inputSchema,
        execute: async (args: Record<string, unknown>) => {
          console.log(`[model:tool] ${abstractName} called by LLM`);
          const result = await entry.handler(args);
          const preview = typeof result === 'string'
            ? result.slice(0, 120) + (result.length > 120 ? '…' : '')
            : JSON.stringify(result).slice(0, 120);
          console.log(`[model:tool] ${abstractName} ✓ ${preview}`);
          return result;
        },
      });
    }

    const toolNames = Object.keys(aiTools).join(', ');
    const promptLen = (system?.length ?? 0) + prompt.length;
    const hasSchema = config.resultSchema && config.resultSchema.length > 0;

    console.log(`[model] generateText+tools → ${logSpec} | tools: [${toolNames}]${hasSchema ? ' +schema' : ''} | prompt: ${promptLen} chars`);

    try {
      const result = await generateText({
        model,
        system,
        prompt,
        tools: aiTools,
        stopWhen: [stepCountIs(5)],
        ...(hasSchema ? {
          output: Output.object({ schema: buildZodSchema(config.resultSchema!) }),
        } : {}),
        ...(providerOptions ? { providerOptions } : {}),
      });

      const tokens = result.usage?.totalTokens;
      const steps = result.steps?.length ?? 1;
      console.log(`[model] generateText+tools ✓ ${steps} step(s)${tokens != null ? ` (${tokens} tokens)` : ''}`);

      return {
        output: hasSchema ? result.output : result.text,
        usage: tokens != null ? { tokens } : undefined,
      };
    } catch (err) {
      console.error(`[model] generateText+tools ✗ ${(err as Error).message}`);
      throw err;
    }
  }
}

// -- Tool schema builder ------------------------------------

/**
 * Converts ToolMeta.args (from list.yml) into a Zod object schema
 * suitable for AI SDK tool({ inputSchema }).
 */
function argMetaToZod(args: Record<string, ArgMeta>): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, arg] of Object.entries(args)) {
    let t: z.ZodTypeAny;
    switch (arg.type) {
      case 'number':  t = z.number(); break;
      case 'boolean': t = z.boolean(); break;
      case 'object':  t = z.record(z.string(), z.unknown()); break;
      case 'array':   t = z.array(z.unknown()); break;
      default:        t = z.string(); break;
    }
    shape[name] = arg.required ? t : t.optional();
  }
  return z.object(shape);
}

// -- Schema builder -----------------------------------------

/**
 * Converts COIL РЕЗУЛЬТАТ fields (tree of ResultSchemaField) into a Zod schema
 * for AI SDK generateObject.
 */
function buildZodSchema(fields: ResultSchemaField[]): z.ZodType {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    const zodType = schemaToZod(field.schema);
    shape[field.name] = field.description
      ? zodType.describe(field.description)
      : zodType;
  }
  return z.object(shape);
}

function schemaToZod(schema: ResultSchema): z.ZodType {
  switch (schema.kind) {
    case 'text':
      return z.string();
    case 'number':
      return z.number();
    case 'flag':
      return z.boolean();
    case 'choice':
      if (schema.options.length > 0) {
        return z.enum(schema.options as [string, ...string[]]);
      }
      return z.string();
    case 'object': {
      const shape: Record<string, z.ZodType> = {};
      for (const child of schema.fields) {
        const childType = schemaToZod(child.schema);
        shape[child.name] = child.description
          ? childType.describe(child.description)
          : childType;
      }
      return z.object(shape);
    }
    case 'list': {
      const itemShape: Record<string, z.ZodType> = {};
      for (const child of schema.itemFields) {
        const childType = schemaToZod(child.schema);
        itemShape[child.name] = child.description
          ? childType.describe(child.description)
          : childType;
      }
      return z.array(z.object(itemShape));
    }
    default:
      return z.unknown();
  }
}
