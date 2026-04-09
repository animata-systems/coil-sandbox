/**
 * Agent source viewer — modal island mounted on top of the vanilla sandbox UI.
 *
 * Read-only. Fetches a single agent's `.coil` source from the server over the
 * existing Socket.IO connection (`get-agent-source` handler, see
 * coil-sandbox/src/web/server.ts) and renders it either as highlighted text
 * (COIL-C view via `EditorView`) or as a structural COIL-H table.
 *
 * Parsing is done once per (source, dialect) — we don't need `PipelineProvider`
 * because there is no editing, validation, or debounce cycle here.
 *
 * Dialect is fixed to `DEFAULT_DIALECT` in the first iteration; auto-detect by
 * content is a deferred follow-up (see `parseWithFallback` comment below).
 */

import { useEffect, useMemo, useState } from 'react';
import {
  EditorView,
  CoilHTable,
  tokenize,
  parse,
  KeywordIndex,
  astToCoilH,
  dialectRegistry,
  DEFAULT_DIALECT,
  LexerError,
  ParseError,
  type CoilHRow,
  type DialectTable,
} from 'coil-ide';

/**
 * Minimal shape of the Socket.IO client we need. We don't depend on
 * `socket.io-client` as a devDep just to type one `emit` overload — the
 * vanilla sandbox page already has a live `io()` socket, we just borrow it
 * via `window.__coilSocket`.
 */
export interface ViewerSocket {
  emit(
    event: 'get-agent-source',
    agentName: string,
    ack: (response: { source: string } | { error: string }) => void,
  ): void;
}

export interface AgentViewerProps {
  agentName: string;
  socket: ViewerSocket;
  onClose: () => void;
}

type ViewMode = 'coil-c' | 'coil-h';

interface ParsedView {
  rows: CoilHRow[];
  parseError: string | null;
  /** The dialect that actually produced `rows`. Differs from DEFAULT_DIALECT
   *  when cascade fallback kicked in (see `parseWithFallback`). */
  resolvedDialect: DialectTable | null;
  /** Dialect key name for the resolved dialect (e.g. 'ru-standard'). Used to
   *  pick the right Monaco language for syntax highlighting in COIL-C view. */
  resolvedDialectName: string | null;
}

function parseOnce(
  source: string,
  dialectTable: DialectTable,
): { rows: CoilHRow[]; error: string | null } {
  try {
    const index = KeywordIndex.build(dialectTable);
    const tokens = tokenize(source, index);
    const ast = parse(tokens, dialectTable, source);
    const rows = astToCoilH(ast, source, dialectTable);
    return { rows, error: null };
  } catch (err) {
    if (err instanceof LexerError || err instanceof ParseError) {
      return { rows: [], error: err.message };
    }
    return { rows: [], error: (err as Error).message };
  }
}

/**
 * Try `preferred` first; if parsing fails, cascade through the remaining
 * dialects in `dialectRegistry` and return the first one that succeeds.
 *
 * This is intentionally NOT content-aware auto-detection — that is a deferred
 * follow-up. It is graceful degradation: in the arena sandbox
 * all shipped examples are `ru-standard` but `DEFAULT_DIALECT` is
 * `en-standard`, so without a fallback the COIL-H table view always shows
 * a parse error. Cascade try fixes this without pretending to know which
 * dialect an agent is really in — if parsing works, that's the dialect we
 * render with. If nothing works, we surface the error from the preferred
 * dialect, which is the one the user would expect.
 */
function parseWithFallback(
  source: string,
  preferredName: string,
  preferred: DialectTable,
): ParsedView {
  const primary = parseOnce(source, preferred);
  if (primary.error === null) {
    return {
      rows: primary.rows,
      parseError: null,
      resolvedDialect: preferred,
      resolvedDialectName: preferredName,
    };
  }
  for (const [name, table] of dialectRegistry) {
    if (table === preferred) continue;
    const attempt = parseOnce(source, table);
    if (attempt.error === null) {
      return {
        rows: attempt.rows,
        parseError: null,
        resolvedDialect: table,
        resolvedDialectName: name,
      };
    }
  }
  return {
    rows: [],
    parseError: primary.error,
    resolvedDialect: null,
    resolvedDialectName: null,
  };
}

export function AgentViewer({ agentName, socket, onClose }: AgentViewerProps) {
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>('coil-c');
  const dialectName = DEFAULT_DIALECT;
  const dialectTable = useMemo(
    () => dialectRegistry.get(dialectName),
    [dialectName],
  );

  // Fetch source on mount and whenever the agent name changes.
  useEffect(() => {
    setSource(null);
    setError(null);
    socket.emit('get-agent-source', agentName, (response) => {
      if ('error' in response) {
        setError(response.error);
      } else {
        setSource(response.source);
      }
    });
  }, [agentName, socket]);

  // ESC closes the modal.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const parsed = useMemo<ParsedView>(() => {
    if (source === null) {
      return {
        rows: [],
        parseError: null,
        resolvedDialect: null,
        resolvedDialectName: null,
      };
    }
    if (!dialectTable) {
      return {
        rows: [],
        parseError: `unknown dialect: ${dialectName}`,
        resolvedDialect: null,
        resolvedDialectName: null,
      };
    }
    return parseWithFallback(source, dialectName, dialectTable);
  }, [source, dialectTable, dialectName]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex h-[85vh] w-[85vw] max-w-[1200px] flex-col overflow-hidden rounded-lg border border-border bg-ide-panel text-foreground shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="font-mono text-sm text-muted-foreground">agent</span>
            <span className="font-mono text-base text-foreground">@{agentName}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex overflow-hidden rounded-md border border-border">
              <button
                type="button"
                onClick={() => setView('coil-c')}
                className={`px-3 py-1 text-xs font-mono transition ${
                  view === 'coil-c'
                    ? 'bg-primary/20 text-foreground'
                    : 'text-muted-foreground hover:bg-foreground/5'
                }`}
              >
                COIL-C
              </button>
              <button
                type="button"
                onClick={() => setView('coil-h')}
                className={`px-3 py-1 text-xs font-mono transition ${
                  view === 'coil-h'
                    ? 'bg-primary/20 text-foreground'
                    : 'text-muted-foreground hover:bg-foreground/5'
                }`}
              >
                COIL-H
              </button>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="ml-2 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-foreground/5 hover:text-foreground"
            >
              ×
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-hidden">
          {error !== null ? (
            <div className="flex h-full items-center justify-center p-6 text-center">
              <div className="text-sm text-muted-foreground">
                <div className="mb-1 font-mono text-destructive">error</div>
                <div>{error}</div>
              </div>
            </div>
          ) : source === null ? (
            <div className="flex h-full items-center justify-center">
              <div className="text-sm text-muted-foreground">Loading…</div>
            </div>
          ) : view === 'coil-c' ? (
            <div className="h-full">
              <EditorView
                value={source}
                readOnly
                dialect={parsed.resolvedDialectName ?? dialectName}
                theme="dark"
              />
            </div>
          ) : (
            <div className="h-full overflow-auto">
              {parsed.parseError !== null || !parsed.resolvedDialect ? (
                <div className="p-4 text-sm text-destructive">
                  Parse error: {parsed.parseError ?? `unknown dialect: ${dialectName}`}
                </div>
              ) : (
                <CoilHTable
                  rows={parsed.rows}
                  dialect={parsed.resolvedDialect}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
