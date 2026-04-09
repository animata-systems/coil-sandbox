# coil-sandbox

Sandbox host environment for COIL. Runs COIL scripts locally with simulated channels, agents, and tools — no production infrastructure required.

## What this is

`coil-sandbox` implements the [SDK interfaces](https://github.com/animata-systems/coil-runtime) of `coil-runtime` as a self-contained local environment. It is the first full integration of the COIL stack.

## What the sandbox provides

| Component | What it simulates |
|---|---|
| Channels | In-memory message space with posts and comments |
| Participants | Mock agents and users addressable by `@name` |
| Tools | Configurable mock tools with fixed or scripted responses |
| LLM provider | Real LLM calls via API (OpenAI, Anthropic) or mock responses |
| Budget | Configurable token and step limits |
| Event log | Step-by-step execution trace |

## Prerequisites

- Node.js >= 22 (the web viewer bundle is built with Vite in library mode, which requires Node 22+)
- npm

## Setup

Install dependencies:

```sh
npm install
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | if using `openai/*` models | API key for OpenAI |
| `ANTHROPIC_API_KEY` | if using `anthropic/*` models | API key for Anthropic |

At least one key must be set — it depends on which models are declared in app's `config.yml`.

## Run

Development mode (auto-reload on changes):

```sh
npm run dev
```

Production (after build):

```sh
npm run build
npm start
```

Both commands launch the default demo app and open a web UI at `http://localhost:3000`.

To run a different app or pass options:

```sh
# dev
npx tsx cli/index.ts <app-path> [--dialect <path>]

# production
node dist/cli/index.js <app-path> [--dialect <path>]
```

`--dialect` defaults to the standard Russian dialect from `coil-runtime`.

### Type check (no emit)

```sh
npx tsc --noEmit
```

## Web UI

The sandbox serves a browser-based interface via Express + Socket.io:

- **Left panel** — channel list, agents, protocol log
- **Right panel** — messages in the selected channel
- Click a message to open its **thread view** (pinned post + comments)
- Click a channel to switch back

Messages from agents appear in real time as protocols execute.

### Agent source viewer

Clicking an agent name in the left panel opens a read-only modal with the source of that agent's `.coil` file. The modal has two views toggled by a switch in its header:

- **COIL-C** — highlighted text in a Monaco editor (read-only).
- **COIL-H** — the structural tabular projection of the script (see the [COIL-H spec](https://github.com/animata-systems/coil/blob/main/spec/11-coil-h.md)).

Both views are rendered with components from [`coil-ide`](https://github.com/animata-systems/coil-ide), so the viewer looks and behaves the same as the standalone playground. The dialect is detected per-file with a cascade-try fallback, so scripts in any shipped dialect render correctly regardless of the default. Press `Esc` or click outside the modal to close it.

The viewer is a React island mounted into the otherwise-vanilla sandbox page on demand; the rest of the UI is untouched and keeps working as before.

## Intended use

- **Learning COIL** — run examples and patterns from the spec locally
- **Script development** — iterate on agent scripts without a production host
- **Testing** — validate agent behavior with deterministic mock tools and participants
- **Spec exploration** — experiment with extended operators and stream behavior

## Not intended for

Production deployment. The sandbox is a development and exploration tool. For production, implement the SDK interfaces against your own host environment (see [coil-runtime](https://github.com/animata-systems/coil-runtime)).

## Related

- [coil](https://github.com/animata-systems/coil) — language specification and examples
- [coil-runtime](https://github.com/animata-systems/coil-runtime) — runtime and SDK interfaces
- [coil-ide](https://github.com/animata-systems/coil-ide) — script editor

---

Animata Systems
