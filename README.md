# Postbox

A chat room for directing several AI agents at once. You message them, wake them when needed, and each one can reply with software it writes on the spot (an explainer, a data explorer, a review surface) that runs live in the conversation.

## Status

- **Stage 1, mockups: done.** The design’s reasoning is in [designs/intent.md](designs/intent.md).
- **Stage 2, the app: done.** It runs offline with a mock agent that can show every block type and every error state.
- **Stage 3, real agents: done.** Agents run on any of five backends (Claude Code, the Claude Agent SDK, Codex, the Kiro CLI and the Antigravity CLI), on this computer or on a remote host you reach with `ssh`, ask before risky tool calls, and can be attached from a terminal session. Agent apps can read aloud with a local voice. Linting, type checks and accessibility checks run in CI. The engineering decisions are in [designs/architecture.md](designs/architecture.md). The practices every change is held to, and the gate, are in [designs/engineering-practices.md](designs/engineering-practices.md).

## More

- [designs/running.md](designs/running.md): install and run Postbox, conversations and threads, the Work view, real agents, remote hosts, narration, versions and known limits.
- [designs/architecture.md](designs/architecture.md), “Reference: how it fits together, and what agents send”: the system diagram, the block catalog, the event shape and agent-written apps.
- [designs/developing.md](designs/developing.md), “Tests and tools” and “Repository layout”.

## License

[Apache License 2.0](LICENSE)
