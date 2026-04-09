/**
 * Agent viewer entry — React island mounted on top of the vanilla sandbox UI.
 *
 * Top-level side effects:
 *   - Imports Tailwind + coil-ide theme so the bundle ships with styles.
 *   - Registers `window.openAgentViewer(name)` and `window.closeAgentViewer()`.
 *
 * Lifecycle:
 *   - First `openAgentViewer` call creates a single React root on
 *     `#agent-viewer-root` and mounts `<ViewerHost>`.
 *   - `ViewerHost` holds `agentName` in state. Subsequent opens update state
 *     (React reuses the root — no unmount/remount churn).
 *   - `closeAgentViewer()` or the internal `onClose` sets state to null,
 *     unmounting the modal but keeping the root alive for next time.
 *   - The root wrapper is `<div className="dark">` so that the `.dark`
 *     palette from coil-ide/theme.css activates only inside the viewer
 *     subtree (see coil-ide/DESIGN.md I-0008). The vanilla sandbox page
 *     stays on the light palette it always had.
 *
 * Mount race handling:
 *   - React 19 `createRoot(...).render(...)` commits asynchronously in
 *     concurrent mode; effects fire after commit. If `openAgentViewer` is
 *     called and then checks a module-level setter that is populated from a
 *     useEffect, the setter may still be null at check time.
 *   - Fix: `pendingAgent` module variable is written BEFORE `ensureMounted()`;
 *     `ViewerHost` initializes its `useState` from `pendingAgent`, so the very
 *     first render already has the correct agent name. After mount, the
 *     `setter` reference is available and subsequent opens go through it
 *     directly. No microtasks, no races.
 */

import { useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AgentViewer, type ViewerSocket } from './AgentViewer';
import './viewer.css';

declare global {
  interface Window {
    /** Open the agent viewer modal for the given agent name. */
    openAgentViewer?: (agentName: string) => void;
    /** Close the agent viewer modal (if open). */
    closeAgentViewer?: () => void;
    /** Live Socket.IO client created by the vanilla sandbox page. */
    __coilSocket?: ViewerSocket;
  }
}

let root: Root | null = null;
let pendingAgent: string | null = null;
let setter: ((name: string | null) => void) | null = null;

function ViewerHost() {
  // Seed from pendingAgent so the first render already shows the right agent,
  // even if ensureMounted → render commits before any click-driven state set.
  const [agentName, setAgentName] = useState<string | null>(pendingAgent);

  // `useState` setters are stable across renders, so capturing into a module
  // ref on every render is harmless and gives openAgentViewer a live handle
  // without needing a useEffect (which would fire after commit).
  setter = setAgentName;

  if (agentName === null) return null;

  const socket = window.__coilSocket;
  if (!socket) {
    // Should not happen — index.html assigns __coilSocket before loading this
    // bundle. Fail loudly rather than silently rendering an empty modal.
    // eslint-disable-next-line no-console
    console.error('[agent-viewer] window.__coilSocket is not set');
    return null;
  }

  return (
    <div className="dark">
      <AgentViewer
        agentName={agentName}
        socket={socket}
        onClose={() => {
          pendingAgent = null;
          setAgentName(null);
        }}
      />
    </div>
  );
}

function ensureMounted() {
  if (root !== null) return;
  const container = document.getElementById('agent-viewer-root');
  if (!container) {
    // eslint-disable-next-line no-console
    console.error('[agent-viewer] #agent-viewer-root not found in DOM');
    return;
  }
  root = createRoot(container);
  root.render(<ViewerHost />);
}

window.openAgentViewer = (agentName: string) => {
  pendingAgent = agentName;
  ensureMounted();
  // If the root is already mounted, push the new name through the setter.
  // If it's the very first mount, the initial useState seed already picks
  // up `pendingAgent`, so this call is a no-op during the first render.
  setter?.(agentName);
};

window.closeAgentViewer = () => {
  pendingAgent = null;
  setter?.(null);
};
