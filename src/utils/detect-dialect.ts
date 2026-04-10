/**
 * Detect dialect annotation from COIL source.
 *
 * Scans leading comment lines for `' @dialect <name>` pattern.
 * Returns the dialect name if found, or `null` if no annotation is present.
 *
 * Format reference: coil/tests/README.md — `' @dialect en-standard`.
 */

const DIALECT_RE = /^'\s+@dialect\s+(\S+)/;

export function detectDialect(source: string): string | null {
  const lines = source.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // Stop at first non-empty, non-comment line
    if (trimmed === '') continue;
    if (!trimmed.startsWith("'")) break;
    const match = DIALECT_RE.exec(trimmed);
    if (match) return match[1];
  }
  return null;
}
