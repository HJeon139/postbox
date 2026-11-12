# Real agents: five backends, one harness-event contract

Part of [the architecture](../architecture.md). How an agent’s harness runs, and how what it does reaches Postbox.

## Five backends behind one interface

**Decision.** A persona runs on one of five real backends, each behind an adapter with one interface ([`server/adapters/adapter.mjs`](../../server/adapters/adapter.mjs)), registered as Postbox starts ([`server/backends.mjs`](../../server/backends.mjs)). The mock agent is a sixth adapter, for the demo and the tests. What each needs and how it differs for the person is in [backends.md](../backends.md).
- **Claude Code:** one `claude -p` process per turn, with stream-json in and out, resuming the thread’s Claude Code session.
- **Agent SDK:** `query()` in Postbox’s process.
- **Kiro CLI:** one headless `kiro-cli chat` process per turn, with stream-json out and a custom agent file Postbox writes for the turn.
- **Antigravity CLI:** one headless `agy` process per turn, with stream-json out and a plugin Postbox writes into the agent’s folder for the turn.
- **Codex:** `codex app-server`, spoken to over JSON-RPC on stdio.

Each adapter declares what its harness can do in `capabilities` (resume, permissions, tools, the permission prompt tool, skills, how it runs on a remote host, and the rest; `adapter.mjs`), and the runtime and the page read that rather than the backend’s name.

## The harness-event contract

**Decision.** Every adapter tells Postbox what its harness did in a turn one way: it reads its harness’s own stream and calls `event()` with the contract’s kinds, in its harness’s order ([`server/harness-events.mjs`](../../server/harness-events.mjs)): text, thinking, tool calls, their results and output, background work ending, refusals, a subagent’s id, context use, progress, status, the end of a message, compactions and the turn’s end. From these, and only there, Postbox builds what it shows and keeps: the reply’s text, each step and its label, the work ledger’s calls, background jobs, the subagents on the ring, the glimpse and the ring’s state. So a behavior fixed there is fixed for every backend, and a new backend maps its stream and gets the rest.

The Agent SDK streams the same messages as the Claude Code CLI, so one mapper ([`server/adapters/claude-stream.mjs`](../../server/adapters/claude-stream.mjs)) turns either into the contract. The others have their own (`codex-events.mjs`, the Kiro and Antigravity adapters).

## Thinking, subagents and the guide

The Claude backends ask for summarized thinking (`--thinking-display summarized`, the SDK’s `thinking.display`) and subagents’ own messages (`--forward-subagent-text`, the SDK’s `forwardSubagentText`). Without them, thinking arrives empty and subagents are a single line. With them:
- While an agent thinks or calls tools, a working row at the end of the conversation shows a glimpse of its thinking.
- Each thought is a step in the activity list.
- Every subagent tool call is a step, under the subagent’s name. 

One guide ([`server/adapters/guide.mjs`](../../server/adapters/guide.mjs)) is what every backend gives its agent, each in its own way ([prompt-review.md](prompt-review.md)), and it teaches the catalog, the kit and the [recipes](../recipes.md). It starts from what a reply contains, not from what the person asked for ([#63](https://github.com/HJeon139/postbox/issues/63)): options become a choice, questions a form, a draft to approve a review block, and a long job a progress block, with one example each. Agents follow defaults more than prose, so it stays short, and a test keeps it under 9,250 characters (`tests/guide.test.mjs`). With it, the room says who else is in the conversation and what each does (their persona’s description), and how to share the work: take your own part, hand work on with what the next agent needs, and read what the others did before redoing it. That comes from the room, not from a persona’s prompt, so any team the person puts together works this way, and an agent alone gets none of it. Two agents on one task did it twice from different decisions ([#121](https://github.com/HJeon139/postbox/issues/121)), and agent teams with explicit handoffs do better than role names alone ([MetaGPT, arXiv 2308.00352](https://arxiv.org/abs/2308.00352)). The seeded personas’ prompts ([`server/personas/`](../../server/personas/)) hold only what changes an agent’s behavior beyond its backend’s own defaults, stated as what to do and why, since adherence falls as instructions pile up ([IFScale, arXiv 2507.11538](https://arxiv.org/abs/2507.11538)).

**What it rests on**
- **No credentials in Postbox.** Every backend uses its harness’s own sign-in (backends.md). Postbox never sees a key, so there’s nothing to store, rotate or leak.
- **Recorded, not guessed.** The stream shapes were taken from real turns (for Claude Code, claude 2.1.296 with `claude-opus-5-5`) and kept as test fixtures in `tests/fixtures/`, with local paths removed. The SDK options follow its shipped type definitions.
- **A process per turn is simple and robust.** A crash affects one turn; Stop is a signal; nothing leaks between turns. The cost is a second or two to resume. A long-lived process per session, with stream-json input, is the upgrade if that matters.
- **One set of limits** ([#50](https://github.com/HJeon139/postbox/issues/50)). The limits an agent can reach (an app event’s 64 KB, an app’s size, each block’s counts and text lengths) live in one module, [`shared/limits.mjs`](../../shared/limits.mjs). The catalog, the event builder and the app kit enforce them from it, and the guide and the MCP tool descriptions are written from it, so an agent is told the number Postbox enforces. A test fails when a limit isn’t in the guide. `postbox.send` over the event limit rejects inside the app, naming the limit, before anything is posted. The chart palettes live there too ([#52](https://github.com/HJeon139/postbox/issues/52)), each with when to use it: `--s1`…`--s8` for categories, `--seq-*` for magnitude, `--div-*` for polarity, and `--good` and `--alert` for status only. A test fails when one isn’t defined in `app/workbench.css`.
- **Postbox’s tools load up front** (`alwaysLoad` on the MCP server), so the agent doesn’t spend a step searching for them.

What each turn is given (setting sources, tools, MCP servers, skills, hooks, model and effort) is in [agent-setup.md](agent-setup.md).

**Revisit when** the start-up delay matters more than isolation, or a harness reports something the contract has no kind for.
