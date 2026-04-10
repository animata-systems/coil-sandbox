import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbDir = join(__dirname, '..', 'db');

export default async function ({ agent }) {
  const filePath = join(dbDir, `${agent}.json`);
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
