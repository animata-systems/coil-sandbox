#!/usr/bin/env node

/**
 * CLI entry point for coil-sandbox.
 *
 * Usage:
 *   coil-sandbox <app-path> [--dialect <path>]
 *
 * Environment:
 *   OPENAI_API_KEY      — for openai/* models
 *   ANTHROPIC_API_KEY   — for anthropic/* models
 */

import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { Sandbox } from '../src/engine/index.js';
import { createWebUI } from '../src/web/index.js';

const require = createRequire(import.meta.url);

function parseArgs(args: string[]) {
  let appPath: string | null = null;
  let dialectPath: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dialect' && args[i + 1]) {
      dialectPath = args[++i];
    } else if (!args[i].startsWith('-')) {
      appPath = args[i];
    }
  }

  return { appPath, dialectPath };
}

async function main() {
  const { appPath, dialectPath } = parseArgs(process.argv.slice(2));

  if (!appPath) {
    console.error('Usage: coil-sandbox <app-path> [--dialect <path>]');
    console.error('');
    console.error('Example:');
    console.error('  coil-sandbox ./apps/story-workshop');
    console.error('');
    console.error('Environment variables:');
    console.error('  OPENAI_API_KEY      — for openai/* models');
    console.error('  ANTHROPIC_API_KEY   — for anthropic/* models');
    process.exit(1);
  }

  // Default dialect: English standard from coil-runtime's coil dependency
  const resolvedDialect = dialectPath
    ?? resolveDefaultDialect();

  const sandbox = new Sandbox(resolvedDialect);

  try {
    await sandbox.load(resolve(appPath));
  } catch (err) {
    console.error(`Failed to load app: ${err}`);
    process.exit(1);
  }

  await createWebUI(sandbox);
}

function resolveDefaultDialect(): string {
  const coilPkg = dirname(require.resolve('coil/package.json'));
  return resolve(coilPkg, 'dialects/en-standard/en-standard.json');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
