import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbDir = join(__dirname, '..', 'db');

export default async function ({ agent, data }) {
  await mkdir(dbDir, { recursive: true });
  const filePath = join(dbDir, `${agent}.json`);

  let existing = {};
  try {
    const raw = await readFile(filePath, 'utf-8');
    existing = JSON.parse(raw);
  } catch {
    // no existing state
  }

  const merged = { ...existing, ...data };
  await writeFile(filePath, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}
