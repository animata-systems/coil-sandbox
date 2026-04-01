// Tool handler: pure async function.
//
// Receives: named arguments as defined in ../list.yml
// Returns:  plain object (becomes $name in COIL scenario after ВЫПОЛНИ / EXECUTE)
//
// Contract:
//   - No side effects on system storage (channels, messages).
//   - Tool may create its own storage next to index.js if needed.
//   - Must be stateless between calls (no module-level mutable state).
//   - Same signature works in sandbox (direct import) and MCP (via wrapper).

export default async function ({ /* %arg-name% */ }) {
  // return { %field%: %value% }
}
