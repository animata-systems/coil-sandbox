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

## Intended use

- **Learning COIL** — run examples and patterns from the spec locally
- **Script development** — iterate on agent scripts without a production host
- **Testing** — validate agent behavior with deterministic mock tools and participants
- **Spec exploration** — experiment with extended operators and stream behavior

## Not intended for

Production deployment. The sandbox is a development and exploration tool. For production, implement the SDK interfaces against your own host environment (see [coil-runtime](https://github.com/animata-systems/coil-runtime)).

## Status

Planned. Development begins after coil-runtime phases 1–5 are complete.

| Component | Status |
|---|---|
| In-memory channel provider | Planned |
| Mock participant provider | Planned |
| Mock tool provider | Planned |
| LLM provider (real API) | Planned |
| Budget policy | Planned |
| Web UI for message space | Planned |
| Execution trace viewer | Planned |

## Related

- [coil](https://github.com/animata-systems/coil) — language specification and examples
- [coil-runtime](https://github.com/animata-systems/coil-runtime) — runtime and SDK interfaces
- [coil-ide](https://github.com/animata-systems/coil-ide) — script editor

---

Animata Systems
