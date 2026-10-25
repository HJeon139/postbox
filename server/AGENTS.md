# The server and the agent backends: server/

Node with zero runtime dependencies. The store is an event log with snapshots (designs/architecture.md, “The store”). The root `AGENTS.md` applies here too.

## Node

These come from designs/engineering-practices.md, “Node”:
- ES modules, built-ins with the `node:` prefix. Anything heavy is an optional dependency, loaded with a dynamic `import()` inside `try`.
- Spawn with an argument array, handle the child’s `error`, and give long work an `AbortSignal` or a kill path. Stop is SIGINT, then SIGKILL.
- `unref()` timers that shouldn’t keep the process alive. Write files atomically: a temporary file, then `rename`.
- Bound what agents and apps send at the boundary where it enters: slice strings, cap arrays, clamp numbers, from `shared/limits.mjs`.
- State that must survive a reload or restart is persisted, never kept only in module memory (#18, #24).
- Every promise is awaited, returned or handled (designs/developing.md, “Async in Node and the browser”).

## Errors and types

These come from designs/developing.md, “Errors” and “Types that refuse the wrong call”:
- An error a person can see says what happened and what to do. HTTP errors go through `httpError(status, message)`.
- Keep the reason when you wrap: put the original message in the text, or pass `{ cause }`. Branch on `e.code`, never on the message.
- An empty `catch {}` says on its line why failure is the expected answer there.
- A domain value is a union of strings, not a pair of booleans. A switch over a union ends in a `throw`.
- Look a key up with `Object.hasOwn`, never `in` (#39). Treat what an agent or app sends as `unknown` until the catalog has validated it.

## Agent backends

These come from designs/developing.md, “Agent backends”, and designs/engineering-practices.md, “Building on Claude Code and the Agent SDK (Anthropic)”:
- Everything that shapes a turn (setting sources, output style, denied tools, MCP config, model, effort) is built in `server/adapters/setup.mjs`, in one place.
- Read what an adapter can do (`capabilities`), never its name. An `if (adapter.name === …)` is a capability nobody declared.
- A fixture is a recorded real turn with local paths removed (`POSTBOX_CLAUDE_RECORD`, `POSTBOX_CODEX_RECORD`, `POSTBOX_KIRO_RECORD`). Never edit one to make a test pass.
- Branch on structured stream fields, never on model text. A turn ends at its terminal event, which the code names.
- Surface what the harness decides: permission prompts, refusals, compaction, subagents and errors all reach the person.
- A change to what reaches a turn is confirmed by reading a real `init` event, and the pull request says what it showed.
- Keep the agent guide, the MCP tool descriptions and the kit in agreement with every limit the server enforces (#50, #52).

## Security

These come from designs/developing.md, “Security”, and designs/architecture.md, “Writes need the page’s token”:
- The request gate in `server/index.mjs` refuses other `Host` headers (DNS rebinding) and cross-site `Origin`s, and needs the page’s token for every write. `/mcp` needs the running turn’s token. `!` commands need loopback.
- Validate every input at the boundary, and refuse rather than normalize. Resolve a path with `realpath`, and refuse it outside its folder.
- Use `node:crypto`: `randomBytes` for tokens, `timingSafeEqual` to compare them.
- `runtime.mjs` is at its ceiling. A new concern goes in a module of its own, as a function that takes `rt` first, with a one-line delegator left in the class (designs/architecture.md, “Module and function size”).
