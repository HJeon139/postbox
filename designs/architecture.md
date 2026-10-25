# Architecture decisions

Decided on 21 October 2026, after Stage 2. Each section states the decision, what it rests on, and what would make us revisit it. [intent.md](intent.md) records the product decisions; this file records the engineering ones.

## 1. The store: an event log with snapshots, not a database

**Decision.** Postbox keeps its data as an append-only event log in JSON Lines, plus periodic snapshots of the state, in its data folder. Every read comes from an in-memory projection of that log. Binary files go to a separate content-addressed blob store. All of this sits behind one small storage interface (`server/store.mjs`).

**What the design needs from a store**

| Need | Where it comes from |
|---|---|
| A numbered, append-only sequence of changes | Live updates over server-sent events must resume after a dropped connection with nothing lost or duplicated, so every change has a sequence number and clients ask for “everything after N”. |
| The current state, rebuilt from those changes | The browser and the server apply the same events with the same reducer (`shared/state.mjs`). The state is a projection, not a source of truth. |
| Durable across restarts | “The conversation survives a page reload: keep it in the app’s own store.” |
| Cheap writes during streaming | A reply streams as many small text events per second. |
| Binary attachments | Pasted images, uploads and files added to the corpus. |
| No schema to maintain, no relational queries | One person, one machine, one process. Every read is “all of it” at startup, then live events. |

**Options considered**

| Option | Fit | Why not now |
|---|---|---|
| One JSON file, rewritten whole (Stage 2) | Simple | Each write serializes the entire state. That’s fine at tens of kilobytes; after months of use it blocks the event loop on every streaming reply. |
| **Event log (JSONL) + snapshots** | Matches the event model exactly. Appends are cheap and crash-tolerant. No schema beyond the event types. No dependencies. | **Chosen.** |
| Redis (Streams + AOF) | Streams are a good log, and AOF is itself an append-only file | Adds a server to install and run, a network hop and a runtime dependency, for one user in one process. It earns its place only with several server processes or users. |
| SQLite (`node:sqlite`, built into Node 22) | Transactions and durability in one file, still schema-light: one events table and one snapshot table holding JSON | Still marked experimental in Node 22, and it prints a warning. It’s the first candidate if we need transactions across files or queries. |
| A document or relational database (Postgres and so on) | — | Schema and operations work with no payoff for this use case. |

**How it works**

```mermaid
flowchart LR
  E["emit(type, data)"] --> R["reducer: shared/state.mjs"]
  R --> M[("in-memory state")]
  E --> L["events-&lt;seq&gt;.jsonl (append)"]
  E --> SSE[server-sent events]
  M -->|every 5,000 events| SN["snapshot.json (atomic write)"]
  SN -->|then| ROT["start a new log segment, delete segments the snapshot covers"]
  subgraph Startup
    SN2[snapshot.json] --> REPLAY["replay log lines with seq greater than the snapshot's"] --> M2[("state")]
  end
```

- **Writes** are batched and appended in order. A crash can lose at most the last few milliseconds of events. A truncated last line is detected on startup and dropped.
- **Snapshots** are written to a temporary file and renamed, so a crash mid-write leaves the old snapshot intact. A new log segment starts after each snapshot, and segments the snapshot fully covers are deleted.
- **Schema.** Events carry plain JSON. If an event’s shape ever changes, the reducer upgrades old events as it reads them (an “upcaster”), so there are no migrations to run.
- **Stage 2 data** in `store.json` is read once as the first snapshot, then renamed `store.json.migrated`.

**Attachments.** Files are stored by the SHA-256 of their contents under `blobs/ab/cdef…`, so identical files are kept once and corruption is detectable. The log holds only metadata: `{ id, name, type, size, sha256 }`. Files are served with `X-Content-Type-Options: nosniff` and a `sandbox` content-security policy. Only PNG, JPEG, GIF and WebP images are shown inline; everything else downloads. Large content never enters the log, so snapshots stay small.

**Revisit when** Postbox runs as more than one server process, serves more than one person, or needs queries across history (for example, search). Then move the same interface onto SQLite or Redis Streams, or Postgres for many users.

## 2. How agent data reaches the store

**Decision.** Everything an agent does arrives through the runtime, which validates it and emits events. Nothing writes to the store directly.

```mermaid
flowchart LR
  subgraph Agent
    Mdl[model]
  end
  Mdl -->|streamed text, tool activity, status| AD["adapter (in the Node process)"]
  Mdl -->|"UI tools: show_block, show_app, define_term, wake_agent…"| MCP["MCP endpoint POST /mcp (JSON-RPC over HTTP)"]
  AD --> RT[runtime]
  MCP --> RT
  RT -->|validate against the catalog| RT
  RT -->|"emit(type, data)"| ST["store: event log + in-memory state"]
  ST -->|server-sent events| B[browser]
  B -->|"HTTP: messages, block actions, app events"| RT
  RT -->|"next message: { kind: 'event', event }"| AD
```

- **Text and activity** stream through the adapter, which runs inside the Node process. For the Agent SDK it’s a library call; for Claude Code it’s the CLI’s streaming JSON output.
- **UI tools** go over MCP, whether the agent is in-process or a separate Claude Code process. They’re validated and return at once.
- **Your actions** come back as HTTP requests and reach the agent as its next message.

## 3. The front end: plain HTML, CSS and ES modules, no build

**Decision.** Keep the shipped app framework-free with no build step, and add type checking and linting as development-only tools, so the app itself still needs nothing but Node to run.

**Does it make Postbox faster for you?** At load, yes:
- **First load.** The app is about 180 KB of uncompressed JavaScript in ten modules plus one stylesheet. There’s no framework runtime, no hydration and nothing to download before the first paint, and a full reload of a long thread renders in well under a second locally.
- **While you use it.** The hot paths are re-rendering Markdown while a reply streams (batched once per frame) and big tables. Neither depends on a framework.
- **The costs are ours, not yours.** We hand-write list reconciliation (`syncList`) and event wiring, which is where Stage 2’s bugs were. There are no compile-time types. Contributors used to a framework need a moment to adjust.

**What we add to keep it fast**
- Serve static files with gzip and ETags instead of always revalidating in full. This is done in this change.
- Virtualize table rows above about 1,000.
- Keep every module small enough to read in one sitting.

**Revisit when** the UI gains shared editing or several people, or the hand-written reconciliation grows past what one file can hold. The first step then would be a small runtime library such as Preact with `htm`, which still needs no build step, rather than a full build pipeline.

## 4. Code quality: linters and checks

**Decision.** These run locally (`npm run check`) and in continuous integration on every pull request, except the two marked CI only, which are GitHub services. Every other tool is a development dependency, pinned in a lockfile and never shipped.

| Check | Tool | What it enforces |
|---|---|---|
| Lint and format | **Biome** (one dependency, no plugins) | Recommended correctness and suspicious-code rules, consistent formatting, no unused code, and a length limit on every file and function (“Module and function size”, below) |
| Types | **TypeScript in `checkJs` mode** with JSDoc types, `noEmit` | Shapes of events, blocks and store state checked without a build. It starts with `shared/` and `server/`, then the client. |
| Tests | `node:test` with `--experimental-test-coverage` | Pure modules (catalog, Markdown, events, BM25, store) stay above 90% line coverage |
| End to end | `tools/shoot-app.mjs` in headless Chrome, plus **axe-core** | Every demo scene renders with no browser errors and no serious or critical accessibility violations |
| Contrast | `tools/contrast.mjs` | Every token pair meets WCAG 2.1 AA in both modes, on the app stage too |
| Design tokens | `tools/lint-tokens.mjs` | No raw colors outside the token blocks, in CSS or in JavaScript |
| Safe DOM | `tools/lint-dom.mjs` | `innerHTML` only where a `lint-allow dom:` comment names the source (the Markdown renderer or Postbox’s own templates); no attribute or style names chosen at run time; `target="_blank"` always with `noopener` |
| Security rules | `tools/lint-security.mjs` | Flags a regular expression built from anything but constants or `escapeRegExp()`; a one-pass tag strip outside `stripTags()`; a `JSON.stringify` splice in a browser check's page code, where `js()` belongs; a `===` or `!==` comparison of a name ending in “token”, where `sameToken()` belongs; and git run outside `runGit()` (SECURITY.md) |
| Copy | `tools/lint-copy.mjs` | American spelling and curly quotes in user-facing strings |
| Code scanning | **CodeQL**, GitHub’s default setup (CI only) | No pull request adds a high or critical security alert, or a CodeQL error: the `protect-main` ruleset requires its results |
| Dependencies | `actions/dependency-review-action` (CI only, `.github/workflows/dependency-review.yml`) | No pull request adds or changes a dependency, shipped or development, with a known vulnerability of moderate severity or worse |

**Conventions**
- An `.editorconfig` sets 2-space indentation, LF line endings and UTF-8.
- Commits are small, with sentence-case subjects.
- Every user-facing string follows the writing rules in [intent.md](intent.md).
- No runtime dependencies without a decision recorded here.

**Exceptions.** A deliberate exception to a project rule carries `lint-allow <rule>: <reason>` on its line or the line above, and a whole file can opt out of one rule with `lint-allow-file <rule>: <reason>` near its top. A reason is required, so every exception says why.

**Where it stands (Stage 3).** Everything in the table runs, locally and in CI:
- TypeScript runs in strict mode over `shared/` and `server/`; the client comes next.
- axe-core found 92 violations on its first run, all fixed: radios that said pressed instead of checked, labels on elements with no role, a button whose name didn’t match its text, and dim text on the review highlight in dark mode. The contrast tool now checks translucent tokens too, which is how the last one was missed.
- Coverage is 89% of lines overall. Of the pure modules, `state.mjs` (88%) is still below the 90% target.

**Revisit when** a tool becomes a bottleneck. Biome and TypeScript are the only tools here that a contributor has to install.

## 5. Real agents: two adapters over one stream

**Decision.** Real agents run on Claude Code, in two ways that share everything but the transport:
- **Claude Code backend:** one `claude -p` process per turn, with stream-json in and out, resuming the thread’s Claude Code session.
- **Agent SDK backend:** `query()` in Postbox’s process.

The SDK streams the same messages as the CLI, so one mapper ([`server/adapters/claude-stream.mjs`](../server/adapters/claude-stream.mjs)) turns either into the turn context: text, activity, ring state, context use, subagents, compactions and refusals.

Both backends ask for summarized thinking (`--thinking-display summarized`) and subagents’ own messages (`--forward-subagent-text`). Without them, thinking arrives empty and subagents are a single line. With them:
- While an agent thinks or calls tools, a working row at the end of the conversation shows a glimpse of its thinking.
- Each thought is a step in the activity list.
- Every subagent tool call is a step, under the subagent’s name. One guide ([`server/adapters/guide.mjs`](../server/adapters/guide.mjs)) is the system prompt both append, and it teaches the catalog, the kit and the [recipes](recipes.md). It starts from what a reply contains, not from what the person asked for ([#63](https://github.com/HJeon139/postbox/issues/63)): options become a choice, questions a form, a draft to approve a review block, and a long job a progress block, with one example each. Agents follow defaults more than prose, so it stays short, and a test keeps it under 9,000 characters. Before it, the room says who else is in the conversation and what each does (their persona’s description), and how to share the work: take your own part, hand work on with what the next agent needs, and read what the others did before redoing it. That comes from the room, not from a persona’s prompt, so any team the person puts together works this way, and an agent alone gets none of it. Two agents on one task did it twice from different decisions ([#121](https://github.com/HJeon139/postbox/issues/121)), and agent teams with explicit handoffs do better than role names alone ([MetaGPT, arXiv 2308.00352](https://arxiv.org/abs/2308.00352)). The seeded personas’ prompts ([`server/personas/`](../server/personas/)) hold only what changes an agent’s behavior beyond its backend’s own defaults, stated as what to do and why, since adherence falls as instructions pile up ([IFScale, arXiv 2507.11538](https://arxiv.org/abs/2507.11538)).

**What it rests on**
- **No credentials in Postbox.** Both backends use Claude Code’s own sign-in. Postbox never sees a key, so there’s nothing to store, rotate or leak.
- **Recorded, not guessed.** The stream shapes were taken from real turns (claude 2.1.296, `claude-opus-5-5`) and kept as test fixtures, with local paths removed. The SDK options follow its shipped type definitions.
- **A process per turn is simple and robust.** A crash affects one turn; Stop is a signal; nothing leaks between turns. The cost is a second or two to resume. A long-lived process per session, with stream-json input, is the upgrade if that matters.
- **One set of limits** ([#50](https://github.com/HJeon139/postbox/issues/50)). The limits an agent can reach (an app event’s 64 KB, an app’s size, each block’s counts and text lengths) live in one module, [`shared/limits.mjs`](../shared/limits.mjs). The catalog, the event builder and the app kit enforce them from it, and the guide and the MCP tool descriptions are written from it, so an agent is told the number Postbox enforces. A test fails when a limit isn’t in the guide. `postbox.send` over the event limit rejects inside the app, naming the limit, before anything is posted. The chart palettes live there too ([#52](https://github.com/HJeon139/postbox/issues/52)), each with when to use it: `--s1`…`--s8` for categories, `--seq-*` for magnitude, `--div-*` for polarity, and `--good` and `--alert` for status only. A test fails when one isn’t defined in `app/workbench.css`.
- **Postbox’s tools load up front** (`alwaysLoad` on the MCP server), so the agent doesn’t spend a step searching for them.
- **Your own setup, with a few overrides** ([#57](https://github.com/HJeon139/postbox/issues/57)). Everything that shapes a turn is passed explicitly, in one place ([`server/adapters/setup.mjs`](../server/adapters/setup.mjs)):
  - **Setting sources:** `--setting-sources user,project,local` (the SDK’s `settingSources`), so an agent has the same skills, slash commands, plugins and permission rules as your terminal. A persona set to Isolated (“Uses your Claude Code setup” off) gets `project,local`: the project’s settings, and the local file where Always allow saves its rules.
  - **Output style:** `--settings '{"outputStyle":"default"}'` (the SDK’s `settings`). The flag layer sits above your user, project and local files, so a style such as Concise can’t fight the agent guide. A real turn confirmed it: with Concise in the folder’s local settings, `init.output_style` read `default`.
  - **Publishing tools:** `--disallowedTools` (the SDK’s `disallowedTools`) removes tools that publish outside Postbox, unless the persona “Can publish outside Postbox”. In a UAT run an agent published its result as a claude.ai artifact, so the work left the conversation. The list is the built-in Artifact, ArtifactComments, ArtifactData and PushNotification, plus connector tools matched by verb (deny rules take globs in the tool name). Outward verbs such as `mcp__*__send_*` match any server; `create` and `upload` match only claude.ai connectors (`mcp__claude_ai_*__create_*`), so a local server’s `create_directory` or `git_create_branch` stays usable: never denied, though it asks first as a write (below). It was built from a real `init` event’s `tools`, and a second real turn confirmed Claude Code removed exactly those. Read-only connector tools stay, and no rule may match Postbox’s own tools, since deny beats allow. A real turn with your connectors and plugin servers loading confirmed it again ([#59](https://github.com/HJeon139/postbox/issues/59)).
  - **Writes outside Postbox:** every mode but Run everything adds ask rules (`permissions.ask` in the settings overlay, `WRITE_TOOLS`) for tools named for writing (`create`, `update`, `write`, `delete` and the rest, at `_` or `-` and in camelCase) and for `gh` commands that file or change issues, pull requests and releases. Claude Code then asks Postbox before each, and the permission card shows the call’s draft as Markdown before anything exists outside. Ask beats allow, so Postbox lets a call through itself when the person settled it: an allow rule that names that tool (what Always allow on the card saves; a whole server allowed for its reads doesn’t count), or a publishing tool for a persona that may publish ([`server/write-guard.mjs`](../server/write-guard.mjs), [#112](https://github.com/HJeon139/postbox/issues/112)). A command is read part by part, as for a chained command (below): a `gh` write in a command substitution or after a heredoc counts, one in a heredoc’s body is data unless a shell is on its line (`bash <<EOF`, `cat <<EOF | bash`), and the command passes only when each of its writes is settled. Where the reading can’t be sure, such as after a quote that never ends, the rest counts as commands too. No rule may match Postbox’s own tools.
    - **Local servers ask too.** A local server can write to a remote service (a doc tool’s server runs on this computer), and Postbox can’t tell which, so the rules don’t skip them. The cost: local write tools, such as a filesystem server’s `write_file`, a git server’s `git_create_branch` or a memory server’s `add_observations`, show one card each until the person presses Always allow on that tool. The user chose this over leaving local servers out (23 October 2026).
  - **Your MCP servers** ([#59](https://github.com/HJeon139/postbox/issues/59)): they load as in your terminal, claude.ai connectors and plugin servers included. Postbox adds its own with `--mcp-config` (the SDK’s `mcpServers`), always named `postbox`. An Isolated persona gets `--strict-mcp-config` (`strictMcpConfig`), so only Postbox’s loads. A persona can turn any of yours off: they go in the settings overlay’s `deniedMcpServers`, the denylist Claude Code merges from every source. A real turn confirmed a turned-off server leaves the `init`’s `mcp_servers`, with its tools. The persona sheet lists the servers found in your config (user, project and local scopes, names only) and the ones the last `init` reported, with that init’s status.
  - **The Tools checklist** ([#5](https://github.com/HJeon139/postbox/issues/5)): an unticked tool is a deny rule in `--disallowedTools` (`disallowedTools`): `shell` denies Bash and Monitor, `web.fetch` denies WebFetch, WebSearch and Monitor. A ticked tool is not an allow rule: `--allowedTools Bash` would skip the permission mode’s ask for every command, so ticked only means “not denied”, and the mode still decides. The map lives in `setup.mjs` (`TOOL_RULES`), taken from a real `init`’s `tools`.
  - **Agents outside Postbox:** SendMessage, ListAgents, RemoteTrigger, CronCreate, CronDelete, CronList, ScheduleWakeup and Workflow are denied unless the persona has `agents.outside` (“Message, schedule or start agents outside Postbox”). They bypass the wake cap and the record of who woke whom; `schedule_wake` and `wake_agent` are Postbox’s way. Personas from before the id existed don’t have it, so they’re denied. Monitor is a command (the Tools above decide it), and EnterWorktree stays: it works in a git worktree of the agent’s own folder, which the permission mode governs.
  - **Model and effort** ([#60](https://github.com/HJeon139/postbox/issues/60)): both are always passed (`--model` and `--effort`, the SDK’s `model` and `effort`), so your own `effortLevel` doesn’t decide them. A persona’s effort is one of low, medium, high, xhigh and max, and defaults to medium, which is what Claude Code uses for `claude-opus-5-5` when none is given (a real turn printed it from `CLAUDE_EFFORT`). Like the model, it’s fixed in a session’s snapshot. The stream reports the model in `init` and in each assistant message, but not the effort, so a session keeps the model that answered its last turn (`lastModel`) and the effort Postbox started it with (`lastEffort`).
  - **Your global CLAUDE.md reaches agents by choice.** A session’s persona snapshot records these settings; like the permission mode, they follow the persona from the next turn, and so do its tools.

**Revisit when** the start-up delay matters more than isolation, or another model provider needs an adapter (the mapper is Claude-specific; the turn context isn’t).

## 6. Permissions: a card in the thread, and an explicit mode

**Decision.** Each persona has a permission mode: auto (the default), ask, accept edits, or run everything. In auto mode, Claude Code’s classifier approves routine actions and sends what it can’t decide to the same place ask mode does: a card in the thread that shows the exact command, while the call waits for your answer:
- **Claude Code:** through `--permission-prompt-tool`, an MCP tool that doesn’t return until you answer, for up to 25 hours (`POSTBOX_TIMEOUT_MS`, [#217](https://github.com/HJeon139/postbox/issues/217)). That’s the timeout Postbox gives its MCP server, so Claude Code waits that long for the call. The card expires a minute sooner (`CARD_WAIT_MS`, [`server/permission-cards.mjs`](../server/permission-cards.mjs)), saying how long it waited ([#220](https://github.com/HJeon139/postbox/issues/220)): Claude Code’s clock starts when it sends the call and the card’s only when the call arrives, so with the same length the card could still take an answer after Claude Code had stopped waiting for it. The other real backends (the Agent SDK, Kiro, Codex, Antigravity) declare `capabilities.promptTool: false`: they aren’t offered the tool, and a call to it is refused at once. The backend is the one the turn started on, so a persona moved mid-turn doesn’t cut off the running CLI’s prompts.
- **Agent SDK:** through `canUseTool`. Its card expires at the same time, though the SDK sets no limit of its own.

```mermaid
sequenceDiagram
  participant A as Agent (Claude Code)
  participant M as Postbox MCP
  participant R as Runtime
  participant Y as You
  A->>M: permission_prompt(Bash, "rm -rf build")
  M->>R: requestPermission
  R->>Y: card in the thread, agent needs you
  Y->>R: Allow, Always allow, Edit, or Don't allow (with a reason)
  R-->>M: allow (with updatedInput or updatedPermissions), or deny with a message
  M-->>A: behavior allow / deny
  Note over R: Stop, the turn ending, or 25 hours unanswered answers deny and marks the card expired
```

**What it rests on**
- **The mode is always passed.** Left out, Claude Code would take `permissions.defaultMode` from your own settings, or `auto`, and an agent you set to ask could stop asking.
- **Every permission tool call is a blocking call, and the only one.** All other Postbox tools return at once. A blocked call must always end, so Stop, the end of a turn and the card’s wait (`CARD_WAIT_MS`, a minute short of `POSTBOX_TIMEOUT_MS`) release it with a no.
- **Agents start in their project’s root folder**, as [intent.md](intent.md) decides, unless the persona names another. Permission mode is what protects that folder. The first live test showed why it matters: the sample project’s folder is the bundled books, and a command the test allowed wrote a file there (since removed).
- **The card is Postbox’s, not a catalog block.** Your answer goes to the waiting tool call, not to the agent as a message.

**Refusals.** Claude Code also refuses calls without asking anyone: auto mode’s classifier, a deny rule, the mode, or a background subagent that can’t ask. It reports each refusal as a `permission_denied` event (with `agent_id` when a subagent was refused), and lists them all in the result’s `permission_denials`. Postbox turns each into a refusal card ([#65](https://github.com/HJeon139/postbox/issues/65)):
- **Allow once and retry:** the exact call (`Bash(rm copy.txt)`) is passed with `--allowedTools`, or the SDK’s `allowedTools`, for the next turn only. The agent is told to try it again exactly as before. A rule that matches a call settles it before auto mode’s classifier runs ([permission modes](https://code.claude.com/docs/en/permission-modes), “How the classifier evaluates actions”; narrow rules such as `Bash(npm test)` stay in effect in auto mode), so this answers most of the classifier’s refusals too. Not all: the same page lists writes to protected paths, critical-path removals and commands with per-command allowed domains as going to the classifier anyway, and `autoMode.classifyAllShell` in your own settings sends every shell command there ([auto mode config](https://code.claude.com/docs/en/auto-mode-config)). Postbox doesn’t detect those yet, so the card still offers Allow once for them.
- **A chained command gets neither** Allow once nor Always allow ([#238](https://github.com/HJeon139/postbox/issues/238)). Claude Code matches each part of `a && b`, `a | b`, `a; b` or `a &` against the rules on its own ([permissions](https://code.claude.com/docs/en/permissions), “Compound commands”), so a rule for the whole line never matches it. Postbox takes a command substitution as a part too, since the same section says deny and ask rules find a command there. A heredoc is read as the shell reads it ([`shared/command-chains.mjs`](../shared/command-chains.mjs)): its word after quote removal ends the body, which isn’t a part, unless the word is unquoted and the body holds a command substitution, which runs, or a shell on its line runs the body. So are a comment (a quote in it opens nothing), `$''` and a process substitution `<( )`, which runs a command as `$( )` does. The card says so, and suggests asking the agent to run the parts as separate commands. A permission card from the CLI’s prompt tool offers no Always allow for one, for the same reason; the Agent SDK’s own suggestions, which are per part, still go to Always allow. The CLI’s own “don’t ask again” saves a rule per part instead; Postbox doesn’t, since rules for the parts of `echo … | base64 -d | bash` would allow every other line made of them.
- **Always allow:** a broader rule (`Bash(rm:*)`, `WebFetch(domain:example.com)`, built in [`server/permission-rules.mjs`](../server/permission-rules.mjs)) goes into `.claude/settings.local.json` in the agent’s folder. That’s where the CLI saves “don’t ask again”, so the terminal and Postbox share it.
- **Leave it:** keeps the refusal.

```mermaid
sequenceDiagram
  participant A as Agent (Claude Code)
  participant S as Stream mapper
  participant R as Runtime
  participant Y as You
  A->>S: system permission_denied (tool, reason, agent_id)
  S->>R: ctx.denied
  R->>Y: refusal card, agent needs you
  Y->>R: Allow once, Always allow, or Leave it
  R->>A: next turn with the rule allowed, and a note to try again
```

- **A call you declined isn’t a refusal.** The result’s list includes calls you said no to on a permission card. The prompt tool passes the call’s `tool_use_id`, the card keeps it, and the runtime skips those.
- **A deny rule still wins.** Claude Code checks deny before allow, so Always allow can’t override your own deny rules, and the card says so.

**Answers on a permission card** ([#66](https://github.com/HJeon139/postbox/issues/66), [#10](https://github.com/HJeon139/postbox/issues/10)). The waiting call gets one of four answers:
- **Allow:** `{ behavior: "allow", updatedInput }`, as asked.
- **Always allow:** allow, and keep allowing calls like it. The card says the rule and where it’s saved before you click.
  - The Agent SDK passes Claude Code’s own suggestions (`canUseTool`’s `suggestions`), and they go back as `updatedPermissions`. Rules go to the folder’s local settings: one suggested for the session only would end with the turn, since each Postbox turn is a new session, and one for the project’s shared settings belongs to the person’s team. The card says when it moved one. A mode is offered only for the rest of the turn, never saved as a default. When the SDK sends no suggestions, or says a saved rule would grant more than the call (`suppressAlwaysAllowRule`), there’s no Always allow.
  - The CLI’s prompt tool gets no suggestions and no agent id: a real turn recorded only `tool_name`, `input` and `tool_use_id`, for the agent’s call and for a subagent’s ([`permission-prompts.json`](../tests/fixtures/claude-code/permission-prompts.json)). So Postbox makes the rule as it does for a refusal ([`server/permission-rules.mjs`](../server/permission-rules.mjs)) and saves it in `.claude/settings.local.json` itself. A rule too long to keep (a command with a heredoc only ever gets its exact text) isn’t offered.
- **Edit:** allow with the input you changed, as `updatedInput`: the command for Bash, with the call’s other fields kept, else the input’s JSON, which has to parse. An input too large to keep on the card (16,000 characters) can’t be edited, only allowed as it is. The recorded turn ran the edited command.
- **Don’t allow:** `{ behavior: "deny", message }`, with your reason in the message, when you give one.

A subagent’s prompt names the subagent. The SDK passes its id (`agentID`, the task’s id, as a refusal’s `agent_id`); the CLI passes only the call’s id, but the subagent’s `tool_use` streams before its prompt arrives, so the stream mapper already knows who made the call.

**The permissions panel** shows one agent in one conversation: its mode, its rules, its folders and its MCP servers. It’s reached from the conversation’s ⋯ and the persona editor.
- **Rules** come from where Claude Code reads them, each with its source: the person’s user settings (only when the persona loads their setup), the project’s shared `.claude/settings.json` (shown, never written), the folder’s `.claude/settings.local.json`, this conversation, and the persona’s Tools (#5) as deny rules. So a rule made in the panel shows in the CLI’s `/permissions`, and the reverse.
- **Saving:** in the folder’s local settings by default, as the CLI saves “don’t ask again”; or for this conversation only, kept on the session and passed with every turn (allow as `--allowedTools`, deny as `--disallowedTools`, ask in the `--settings` overlay’s `permissions.ask`); or in the person’s user settings. Changes to one file run one at a time, and each is written atomically, beside the real file: a settings file that’s a link stays a link. One that isn’t valid JSON is named and left alone. User settings follow `CLAUDE_CONFIG_DIR`, as Claude Code’s do.
- **Folders** added for a conversation go to `--add-dir` (the SDK’s `additionalDirectories`) from the next turn.
- **The mode** is the persona’s, so it reaches running conversations from their next turn, as [intent.md](intent.md) says. On an Agent SDK turn that’s running, Postbox also tries the query’s `setPermissionMode`; the SDK documents it for streaming input only, and Postbox sends one prompt string, so the panel says whether it applied now.
- **Which rule decides** a typed call is answered in Claude Code’s order: deny, then ask, then allow, then the mode, with the rule forms Claude Code documents ([`shared/permission-match.mjs`](../shared/permission-match.mjs)). The panel says Claude Code has the final say: hooks, managed settings and its own checks aren’t modeled.

**Revisit when** the CLI’s prompt tool passes `permission_suggestions` (then the CLI’s cards can use them too), or Postbox runs SDK turns with streaming input, so the mode and rules can change during a turn.

## 7. Attached sessions: resume and mirror

**Decision.** A Claude Code session started in a terminal can join Postbox as an agent:
- **Writing to it:** Postbox resumes that session in its own folder.
- **Watching it:** Postbox follows its transcript in `~/.claude/projects/` and mirrors turns typed in the terminal, marked “from terminal”.
- **No duplicates:** lines written while a Postbox turn runs are that turn, already in the thread, so they’re skipped, and the tail jumps to the end when the turn finishes.

**What it rests on.** The transcript is the only shared record, and it records who started each turn (`turnOrigin`: human or sdk). Reading it needs no cooperation from the terminal.

**Revisit when** two writers become a problem in practice. Postbox can’t tell that a terminal turn is still running, so it relies on you to let it finish.

## 8. Narration: a local voice in its own process

**Decision.** Agent apps read aloud with Kokoro, through `kokoro-js`, in a child process that starts on first use and stops after five idle minutes.
- **Audio:** each clip is stored once in the blob store, under its SHA-256, and reused for the same text and voice.
- **Delivery:** the app gets the audio over the postMessage bridge and plays it from a `blob:` URL, the one media source the sandbox allows.
- **Pace:** the kit synthesizes on Play, one passage at a time, so the pre-display check makes no audio.

**What it rests on**
- **Local and free.** No audio leaves the computer, and there’s no account.
- **Isolation.** Kokoro brings native packages with open advisories (`sharp`, `onnxruntime-node`). In a child process, they never run inside the server that holds your conversations.
- **It degrades to text.** The transcript is always on screen; without the voice, the player says so and the walkthrough still reads.

**Revisit when** word-level timing matters (Kokoro gives none, so the transcript follows by passage), or a better local voice appears.


## 9. Topic threads: forked sessions at checkpoints

**Decision.** A topic thread is a thread of kind `topic` whose `parentId` is its conversation and whose `rootItemId` is the message it started from. Each agent in it runs a new session that forks the conversation’s session at that message.

```mermaid
sequenceDiagram
  participant C as Conversation session
  participant R as Runtime
  participant T as Topic thread session
  C->>R: turn ends, checkpoint { claudeSessionId, uuid of its last message }
  R->>R: stamp the turn’s messages with the checkpoint
  Note over R: You choose Reply in thread on a message
  R->>T: new session, fork = the last checkpoint at or before that message
  T->>T: first turn: claude --resume conv --fork-session --resume-session-at uuid
  T-->>R: its own session id, kept for later turns
  Note over R: Send to conversation / Summarize back
  R->>C: the text waits as context for the conversation's next turn
```

**What it rests on**
- **Checkpoints, not copies.** Every adapter reports where its turn ended in its own transcript (`ctx.checkpoint`): Claude Code and the Agent SDK give the last assistant message’s uuid, and the mock gives its session. The runtime stamps each message of the turn with it, so any message knows its fork point. Postbox never copies or edits a transcript.
- **Verified live.** A session told “apple”, then “banana”, then forked at the first reply, remembered only “apple”, under a new session id. The original still remembered both. The CLI’s `--resume-session-at` is undocumented in `--help`; the Agent SDK documents it as `resumeSessionAt` with `forkSession`.
- **Your message as the root.** For a message you wrote, the fork point is the agent’s last finished turn before it, and the message itself opens the thread as context. An agent that joined the conversation after the root starts fresh; replies from before checkpoints were kept fall back to the session’s latest point.
- **A branch point that’s gone falls back to the latest point, once** ([#61](https://github.com/HJeon139/postbox/issues/61)). When the checkpoint’s message is no longer on the conversation’s chain, Claude Code fails the fork with `No message found with message.uuid of: …` (in `result.errors`). Both adapters then save the fork without its uuid, so no later turn goes back to it. They run the turn again from the conversation’s latest message, with a note to the agent that it couldn’t start where it branched. Nothing from the failed run is kept: no session id, no checkpoint. Every failed turn shows Claude Code’s own reasons, bounded, rather than only “hit an error”.
- **Bringing things back costs no turn.** Shared text is queued as context on each of the conversation’s sessions and prepended to the next message they get, so the main agent reads it when it next works rather than being woken by it.
- **No nesting.** A topic thread can’t start another one, as in Slack; a reply that deserves its own branch can be sent to the conversation and branched from there.

**Revisit when** the Claude Code CLI documents or drops `--resume-session-at`. The Agent SDK path documents it and could take over the Claude Code backend’s forks.

## 10. Sandboxed pages that load nothing

**Decision.** An agent app or diagram page is sandboxed by its response header, `Content-Security-Policy: sandbox allow-scripts; …`, not by the iframe’s `sandbox` attribute. It is self-contained:
- **Inline:** the kit, the stylesheet and the diagram script are inlined into the page when it’s served.
- **Libraries:** D3, KaTeX and Mermaid reach it as text over the postMessage bridge, and run as inline scripts. KaTeX’s fonts travel inside its stylesheet as `data:` URLs.
- **Policy:** it allows inline code, `data:` images and fonts, and `blob:` audio, and nothing that loads from a URL.

**What it rests on**
- **Measured in the browser people use.** The Claude desktop app’s browser pane refuses to load any frame that has the `sandbox` attribute (`ERR_BLOCKED_BY_CLIENT`). It also blocks every request a sandboxed, opaque-origin page makes, while letting its inline scripts run. Headless Chrome allowed all of it, which is why the end-to-end runs passed while apps and diagrams stayed blank in the pane.
- **The same isolation.** The header sandbox gives the page an opaque origin, exactly as the attribute does. The host’s bridge only answers frames whose origin is `null`: if a page ever arrived without the header, it would be same-origin, and the bridge would shut it instead of serving it. A test checks that every sandbox page carries the policy.
- **Sturdier everywhere.** A page that needs no requests can’t be broken by an extension, a proxy or a slow network.

**Revisit when** apps need large assets of their own. Then serve them from a separate origin rather than relaxing the policy.

## 11. Diagram legibility: estimate, then measure

**Decision.** Two checks find Mermaid diagrams too small to read, and both reach the agent as a `lint` message that says what to change. Each diagram is reported once.
- **The estimate** ([`shared/diagram-lint.mjs`](../shared/diagram-lint.mjs)) runs on each finished reply. It reads the Mermaid source well enough to estimate the layout’s width, and from that the size its text ends up at in the 728 px column. It also flags too many boxes, one row of many boxes, and long sequences.
- **The measurement** happens in the browser after a diagram renders: its text size is 13 px × the scale it was drawn at. Anything under 10 px at the conversation’s width is reported to the server, unless the estimate already caught it.

**What it rests on**
- **It’s the symptom people see.** A wide diagram doesn’t fail; it shrinks. Text size is the measure that matches what a reader experiences, so both checks use it.
- **Fitted, not guessed.** The estimate’s layout constants (8.5 px per character, about 56 px of padding per box, the gaps between sequence participants) were fitted to diagrams rendered in Chrome. They agree to within about half a pixel, and the measured values are a test.
- **Prevention first.** The agent guide asks for about five boxes side by side, top-to-bottom chains, short labels and lists as text, so most diagrams never trip either check.
- **No loops.** A reply to a lint message isn’t linted again by either check.
- **One pipeline for every check.** Each check returns problems, `{ code, message, scope }` ([`server/checks.mjs`](../server/checks.mjs)). The runtime gathers the problems one agent turn caused into one lint turn: the server’s checks run when the turn ends, and what the browser reports (a diagram measured or failing to draw, the app check’s warnings) joins them within a moment of rendering. A turn gets at most one lint turn, and a lint turn that only calls tools, such as `define_term`, shows as a one-line note rather than a reply.
- **A reply that should have been a block** ([#63](https://github.com/HJeon139/postbox/issues/63)). Agents drift back to prose over a long session, so every reply is checked for how it ends: options in a list with a question or “pick one”, three or more questions, a draft of 40 lines or more that asks for sign-off, or a Markdown table of ten rows or more. A turn that showed the matching block, or followed a request for Markdown or prose, isn’t flagged. Each finding costs a lint turn, so the check is conservative; its lint turn asks for the block and needs no reply.

**Revisit when** another diagram type becomes common (class, state and ER diagrams only get the count check), or Postbox’s column width or diagram font size changes; then re-measure and refit.

## 12. A conversation is shared memory

**Decision.** Every agent in a conversation can read all of it.
- **A marker per session:** each session records the last item it was given (`seenItem`).
- **Catch-up:** each delivery starts with the items after that marker, written as plain lines (“You: …”, “@indexer: …”, “@critic showed a review block …”), leaving out the agent’s own messages and the message being delivered.
- **Caps:** at most 40 items or about 16,000 characters, saying how many earlier ones were left out.
- **Joining:** a new session starts with no marker, so an agent that joins a room gets its recent history.
- **Further back:** `read_conversation` returns older history on request.
- **Long items** ([#109](https://github.com/HJeon139/postbox/issues/109)): the catch-up and `read_conversation` cut each item at 2,000 characters, and a cut says how much it kept and gives the item’s id, such as “… (2,000 of 5,412 characters; read_message { id: "it_4kQ2xY9a" } has the rest)”. `read_message` returns that one item in full, 40,000 characters at a time, so a history stays small and a reviewer can still read every word.
- **Blocks** ([#153](https://github.com/HJeon139/postbox/issues/153)): a block’s line carries what it holds, so an agent asked to review another’s draft can read it. A review, card or code block gives its content, with a review’s comment threads; a choice or form its prompt and its options or fields; a table, progress or image block its fallback; and an answered block your answer. An app is its title alone. The line is cut like any other item, and `read_message` takes the item’s id or the block’s.
- **Commands you ran** with `!` ([#67](https://github.com/HJeon139/postbox/issues/67)) are items like any other: each agent reads the command, where it ran, how it ended and the last 4,000 characters of its output, on its next turn. Running one wakes nobody, as Claude Code’s bash mode only adds to the context.
- **A skill or command** an agent runs from the / menu is the whole prompt, since Claude Code runs `/name args` only at the start of one. Its catch-up waits for the agent’s next turn.

**What it rests on.** Issue #1: in a room, an agent woken by an @-mention saw only that message, and answered confidently about a discussion it had never seen. The catch-up costs nothing when nothing was missed, as in a direct message where the agent is woken by every message; it replaces the separate path shares from topic threads used to take.

**Revisit when** rooms get long enough that 40 items is too little. Then summarize older stretches instead of dropping them.

## 13. Writes need the page’s token

**Decision** ([#74](https://github.com/HJeon139/postbox/issues/74)). Every write to Postbox’s API (any method but GET and HEAD) needs a secret that the page you opened holds. Writes without it get 403, with a message saying why.
- **The secret:** 32 random bytes, made each time the server starts.
- **How the page gets it:** in a cookie set when a browser loads `/`, named for the port (`pb_token_<port>`), with `HttpOnly`, `SameSite=Strict` and `Path=/`. The browser sends it with the page’s own requests, so the page’s code never handles it.
- **Only a browser gets it:** the cookie comes only with a request that carries a browser’s Fetch Metadata: a navigation (`Sec-Fetch-Mode: navigate`), or `Sec-Fetch-Site` of `same-origin` (the page’s own fetch of `/`, its refresh after a restart) or `none`. A request without them, such as a plain `curl /`, gets the page and no cookie.
- **The check:** a constant-time comparison, before any route runs.
- **Agents keep their own way in:** `/mcp`, which carries the agent’s session and its turn’s token. Since #54, a tool call needs the token of the session’s running turn, which only the backend process Postbox started for that turn has; a call with only the session id is refused.

```mermaid
sequenceDiagram
  participant P as The page
  participant S as Postbox
  participant A as An agent’s curl
  P->>S: GET /
  S-->>P: the app, and Set-Cookie pb_token_port (HttpOnly, SameSite=Strict)
  P->>S: POST /api/threads/…/messages, with the cookie
  S-->>P: 201, posted as you
  A->>S: GET /, no Fetch Metadata headers
  S-->>A: the app, no cookie
  A->>S: POST /api/threads/…/messages, no cookie
  S-->>A: 403, the request came from outside the Postbox page
```

**What it protects against.** An agent that uses Postbox’s own API casually, or on generic instructions, to speak as you: one `curl` used to post a message as you, with no click, no card and no “Sent from” line, and the other agents in a room acted on it as your instruction. Now that `curl` gets 403, and so does one that loads `/` first. Another website can’t do it either: the browser doesn’t send a `SameSite=Strict` cookie with another site’s requests. A page on another port of this computer is the same site, so the browser does send the cookie with its requests; the `Origin` check is what refuses those. Apps can’t reach it: their frames have an opaque origin and no network.

**What it doesn’t.** A process running as you that sets out to get in still can: it can forge a browser’s headers when it loads `/` and keep the cookie, or read the data folder. That includes an agent whose instructions, from you or from a page it read, tell it exactly how. Postbox runs on your computer as you, so anything else running as you is out of its reach. The token makes the casual path fail; it isn’t a boundary against a determined process.

**What it costs.** A restart makes a new token, so an open page’s next write is refused once; the page then loads `/` again, gets the new cookie, and retries. Tools that write from Node (`tools/demo.mjs`, the checks) are the person’s own, so they load `/` with a navigation’s headers, as a browser does.

**`!` commands** ([#67](https://github.com/HJeon139/postbox/issues/67)) run as you, through your shell, in the conversation’s folder, so they need more than the token, which a determined process can get (above): the route also refuses unless Postbox listens on 127.0.0.1 and the request came from this computer. Each runs in its own process group, so Postbox stops them all when it shuts down (SIGINT, then SIGKILL), and keeps a bounded amount of each one’s output. Postbox listens there today; the check means a later change to the listen address can’t open it silently. Your shell is the point here: you typed a command line, as in your terminal. That’s different from the rule against spawning through a shell, which is about strings from agents and data.

**Revisit when** Postbox listens beyond localhost, or serves more than one person. Then it needs real sign-in, not a page token, and `!` stays off.

## 14. The work ledger: built from tool calls, counted from diffs

**Decision** ([#132](https://github.com/HJeon139/postbox/issues/132)). Each conversation keeps a ledger of what its agents’ turns changed, ran and published, and what they cost ([`server/ledger.mjs`](../server/ledger.mjs), with the shared counting and totals in [`shared/work.mjs`](../shared/work.mjs)). It lives in the store as `state.work[conversationId]`, a list of entries (`turn`, `file`, `change`, `command`, `commit`, `push`, `branch`, `external`, `publish`, `read`, `restore`) added and patched by `work.add` and `work.patch` events, so the Work view and the list under each turn’s last reply update live like everything else. A `publish` is an app the turn showed or updated, at its version, or a block it showed, read from the store when the turn ends; a `read` is a Read, Grep, Glob, WebFetch or WebSearch call’s path, pattern, URL or query (#195). The list’s rows come from the same entries (`turnRows` in [`shared/work-list.mjs`](../shared/work-list.mjs)), so the list and Work can’t disagree. File copies and command output go to the blob store, never into the log.

```mermaid
flowchart LR
  S[Claude Code stream] --> M[stream mapper]
  M -->|"toolUse: whole input, before it runs"| L[ledger]
  M -->|"toolResult: tool_use_result"| L
  M -->|"taskEnded, usage"| L
  L -->|"read the file before / after"| F[(person’s files)]
  L -->|copies, output| B[(blob store)]
  L -->|"work.add / work.patch"| ST[(store)]
  L -->|"each command: HEAD and branches"| G
  W[Work view] -->|"GET …/work/git"| G["git, read only"]
```

**What it rests on**
- **Recorded, not guessed.** Two real turns are fixtures ([`ledger-edits.jsonl`](../tests/fixtures/claude-code/ledger-edits.jsonl), [`ledger-push.jsonl`](../tests/fixtures/claude-code/ledger-push.jsonl)). They show what the stream gives on the event that carries a tool’s result (`tool_use_result`):
  - Edit and Write give the file’s contents before the change (`originalFile`, null for a file Write created), and git’s line counts.
  - Bash gives its `stdout`, `stderr` and `interrupted`, a `backgroundTaskId` for a background command, and `gitOperation` with `commit: { sha, branch }` and `push: { branch }`. A `vcs_state_changed` system event names the repository’s folder.
  - A failed command’s result starts “Exit code N”.
  - A background command ends with `task_notification` (its tool call’s id, a summary with its exit code, and its output file), and that can come after the turn’s first `result`.
  - `total_cost_usd` and `modelUsage` are running totals for the process, so a turn’s spend is its last result’s, summed over the processes a turn ran (a fork retried).
  - A subagent’s results carry no `tool_use_result`.
- **The file before.** It’s read synchronously the moment the call’s whole input is known, which can lose the race with the tool. The tool’s own `originalFile` replaces that read whenever the result has one, so only a subagent’s edits rely on the race.
- **Counted from the diff.** Lines are counted with Myers’ algorithm the way `git diff --numstat` counts them: a missing final newline changes the last line. A file’s count is against the copy from before the agents’ first change in the conversation, so edits that are put back count as nothing. Each turn’s own change is kept too, so the lines written along the way show beside the lines kept. Kept lines count toward the agent that changed a file last, so the agents’ rows add up to the conversation’s.
- **Git is only read.** Where each file stands comes from `git status --porcelain`, `git log -1 -- <file>` and `git branch -r --contains`, run with an argument array and `GIT_OPTIONAL_LOCKS=0`, so an agent committing at the same moment never meets Postbox’s lock. A commit’s files and lines come from `git show --numstat`, so they match git.
- **Restore never overwrites newer work.** It writes the copy from before atomically beside the file, or removes a file an agent created, and only when the file on disk still matches the agents’ last change. The conversation gets a line in the person’s voice, which is how the agents learn of it.

**What a command committed.** In a git folder, the ledger reads HEAD and the branches, local and remote, as each command starts and again when it ends ([`server/ledger-commands.mjs`](../server/ledger-commands.mjs)), read-only, without git’s optional locks. Reading them is quick, and a commit takes longer to make.
- **What's recorded:** a commit HEAD or a moved branch gained since the command’s own start, with a committer date from after it started, is recorded on the branch that gained it. That covers a commit inside `… && git commit -q` that the tool call didn’t report (#156).
- **What isn't:**
  - A commit the command’s start already had.
  - One a remote branch has, as after a pull or a rebase onto it, unless the command pushed.
- **Commits that left:** a commit HEAD no longer has, nor any branch (amended, reset or rebased away), is marked as left.
- **A new repository:** in a folder that became one during the command (`git init`), its commits are recorded.
- **Overlaps:** a commit made while commands overlapped in one repository is recorded under each of them, each in its own conversation, marked as overlapping.
- **Where it compares:** always in the repository the command’s start was read in. Claude Code’s own folder for git (`vcsCwd`) can be left over from an earlier command, so it doesn’t count here.
- **Tests:** `tests/work-git.test.mjs` uses a repository in memory, and `tools/check-ledger-git.mjs` runs the same cases against real git in temp folders.

**What it doesn’t see yet.** A file a command changes (a formatter, a script, `sed -i`) isn’t listed: only the file tools name files. Comparing `git status` and `git diff --numstat` as a command starts and ends was tried in #226 and set aside. Git answers for the start about 10–30 ms after Postbox hears of the command, and a quick `sed` can finish sooner. #240 takes the snapshot before the command runs, through Claude Code’s PreToolUse hook. A background command still running when its process ends is shown as having said nothing about how it ended (#129). Artifacts (recordings, reports, screenshots) and servers or ports a command started aren’t picked out yet.

**Where it shows: the right pane.** Work is one of the conversation’s side views in the right pane ([`app/js/pane.mjs`](../app/js/pane.mjs)), beside a thread or alone, not a page of its own. What’s open is in the address after the conversation’s path, so a reload restores it and the views change in place without rebuilding the transcript:

```mermaid
flowchart LR
  A["#/t/conv/side/thread?work&turn=t1&full=work&at=item"] --> R[route]
  R -->|sideId| T[thread view]
  R -->|work, turn| W["Work view: compact form (mountWorkPane)"]
  R -->|"full=work, at"| F["Work’s full form (mountWork), in its place"]
  R -->|full=thread| TF["the same thread, fixed over the window"]
  R -->|"telemetry, report (planned, #230)"| TV["Telemetry view, in Work’s place"]
  R -->|"full=telemetry"| TVF["Telemetry’s full form, in its place"]
  T & W & TV --> P["pane: one view, or split by a divider"]
```

- `work` opens the compact form, `turn` scrolls it to a turn’s line (or, full screen, shows that turn alone), `full=work` or `full=thread` shows that view full screen, and `at` opens one item in full-screen Work.
- **Telemetry (planned, [`telemetry-persona.md`](telemetry-persona.md), R18).** A recorded conversation’s Telemetry view is a third pane view under the same contract. `telemetry` opens its compact form (the report’s summary, its exact bytes with Leave out, and the saved reports), `report=<id>` opens one saved report, and `full=telemetry` its full form, with the summary beside the bytes. It swaps in for Work, in Work’s place above an open thread: opening it while Work is open hides Work, and closing it brings Work back, so `pb-work-<id>` still says whether Work is open. An unsaved report draft lives in Postbox’s telemetry folder, not the address or `localStorage`, so a reload shows the same bytes without a second classifier call. It reads only the conversation’s telemetry folder, never the ledger, and nothing in it reaches an agent.
- **One contract for a pane view:** a compact form in the pane and a full form over the window, with the app frames’ full-screen icon (#45) in its head. Full screen doesn’t move or rebuild the view: pane.mjs fixes the view’s own element over the window (`pane-full`), makes it a modal dialog while it lasts (Tab stays in it; Escape or the icon ends it, with focus back on what opened it: the icon, or the item chosen in the pane), and Work swaps its body for `mountWork`. So a thread keeps its composer draft, its scroll (#88’s anchor holds through the width change) and a streaming reply. App frames keep their own full screen (#45). #138’s page addresses, `#/t/<id>/work` and `/work/<turnId>`, are replaced by these.
- Opening and closing Work replaces the address instead of adding to the history, and the browser remembers per conversation that Work was left open (`pb-work-<id>` in `localStorage`), so a link to the conversation or one of its threads opens it beside them again, in a window with room for both (below, the conversation opens on its own: “Room for the conversation”). A thread left open is remembered the same way (`pb-side-<id>`, #122), in [`app/js/pane-route.mjs`](../app/js/pane-route.mjs): coming back from another conversation opens it again, while it’s still there, and closing it while you stay in the conversation forgets it. The divider’s place is kept the same way (`pb-pane-split`). All four (`pb-work-<id>`, `pb-side-<id>`, `pb-pane-split` and `pb-pane-w`) are this browser’s conveniences, not state anyone else needs.
- The pane’s width is `--pane-w`, which `pane-width.mjs` sets. A handle on the pane’s left edge changes it (#86): a separator that ← and → move by 16 px, Home and End take to the pane’s minimum and to the most the column’s minimum allows, a drag moves, and a double-click puts back at 440 px. Its width is kept like the divider’s place (`pb-pane-w`), and app frames, as wide as the transcript, resize with it.
- **Room for the conversation** (#197). Beside the pane, the conversation column (`.main`, with its padding) never gets narrower than 640 px (`COL_MIN` in [`app/js/pane-width.mjs`](../app/js/pane-width.mjs)). Measured on 23 October 2026 in Chrome with the demo seed: the composer’s text box is the column less 207 px, and a reply’s text the column less 48 px. #197 found a 129 px text box (a 336 px column) unusable. At 640 px the text box is 433 px, about 60 characters, a reply’s text 592 px, and the composer’s hints take three lines (four below a 520 px column). To keep the column, the rail hides first (#7), for as long as the pane is open (`rail-auto`, which leaves the person’s own choice, `pb-rail`, as it was); ⌘\ shows it again for that while. So at 1280 px an app beside a thread gets 792 px, where #7 measured about 590 px with the rail open; the rail hides wherever the pane needs its room, below 1,328 px with the pane at 440 px, rather than at #7’s fixed 1,440 px. Where the pane’s minimum doesn’t fit beside the rail (below 1,208 px), the rail stays hidden, and its button says why rather than pushing the pane full screen over it. Then the pane gives up width, down to its own minimum of 320 px. Every width here is the page’s, without a classic scroll bar (`document.documentElement.clientWidth`), which Windows, Linux and some macOS settings take from the window. Where even that doesn’t fit, the pane’s view opens full screen instead (the view opened last, as `full=` shows it), while the address still says only what’s open, so a wider window puts the pane back beside the conversation. Escape there brings the conversation back by closing what’s open, since there’s no pane to go back to. Below 768 px the pane covers the conversation, as before.
- Both forms read the same ledger through `summarize()` and ask git through the same endpoint; the compact form adds nothing to the store.

**Revisit when** the CLI reports files a command changed (then use that, in place of #195’s git comparison), or when the Agent SDK’s results stop carrying `tool_use_result`.

## 15. Module and function size: a ceiling that only comes down

**Decision** (23 October 2026). Biome fails any file or function longer than its default, with `noExcessiveLinesPerFile` and `noExcessiveLinesPerFunction` as errors, over everything it checks. Each file that was already longer that day has an override in `biome.json` at the size it had, as Biome counts it: a ceiling for the file, and one for its longest function. These files can shrink but not grow, and every new file and function starts under the default.

**What it rests on**
- **The rule was written down and never enforced.** “Small enough to read in one sitting” (“The front end”, above) and developing.md’s one concern per module had no check behind them. `server/runtime.mjs` grew from 3,372 to 4,361 lines between v0.2.0 and v0.13.0, in under a day, and `mountComposer` in `app/js/thread.mjs` became a single function of over 800 lines. The wave prompts split files between sessions by region (“Change only the block functions”), so each session grew its region in place.
- **Biome’s defaults, not a number of our own.** Nothing in Postbox measured a better one, so the defaults stand until something does. That day, 47 of the 158 files Biome checks were over the file limit, and 120 functions in 41 files were over the function limit: 58 files have a ceiling.
- **A ceiling, not an exemption.** A `biome-ignore` turns the check off for good; an override at today’s size keeps it on. With one line added to `server/runtime.mjs`, Biome fails: “This file has too many lines (3980). Maximum allowed is 3979.”
- **The function ceiling is per file.** Biome sets options per file, not per function, so a file’s longest function sets the ceiling for all of its functions, and a shorter one could grow up to it. Review catches that, and splitting the file ends it.
- **A wrapper is a module scope, not a function.** A script that isn’t a module, such as `app/kit/kit.js`, wraps all of its code in one IIFE, so Biome counted the whole file as one 619-line function. Its override sets `skipIifes`, so its function ceiling was its longest real function’s (`legibility`, 69 lines). `legibility` then moved, with the pre-display check, to `app/kit/check.js`, whose override sets `skipIifes` too, as does `app/kit/check-layout.js`’s at the default 50. The integrator lowers `kit.js`’s ceilings to what’s left.

**How a ceiling moves**
- **Down:** a change that shrinks an offender lowers its ceilings to the new sizes in the same change, and removes the override once the file is under the default. No check enforces this yet, so the reviewer does.
- **Never up in the change that tripped it** (developing.md, “Lint and type-check exceptions”). A file that needs to grow is split first. A split that needs a design, as `server/runtime.mjs` does (which module owns which of its state), is decided in this document before its code moves.
- **Test files too** (decided by the person, 23 October 2026). A test for code whose test file is at its ceiling goes in a new test file rather than raising the ceiling. The new file is named for the module and the concern, `tests/<module>-<concern>.test.mjs`, such as `tests/runtime-jobs.test.mjs` (developing.md, “Modules”). It must end in `.test.mjs`: `npm test` runs only `tests/*.test.mjs`, so a file named anything else runs nowhere and passes.
- **A ceiling moves with the code** (decided by the person, 23 October 2026). A function moved out of a file at its ceiling may take an override at its current size into its new module, and so may the new module’s length when the moved code is past the file default. The old file’s ceilings drop to its new sizes, as Biome reports them. Without this, a concern couldn’t leave `server/runtime.mjs` without rewriting its long functions in the same change, which would hide the move inside a refactor.
- **What a move may change.** A method of a class that moves into a module becomes a function that takes the instance first: `rt` for `Runtime`, `ledger` for `Ledger`, as `askForTool(rt, …)` in `server/tool-ask.mjs` does. So:
  - `this` becomes that parameter, and nothing else in a body changes.
  - The class keeps a one-line method that delegates to it (`agentWake(...a) { return agentWake(this, ...a); }`), so callers and tests don’t change.
  - A static becomes a module constant, and the class keeps an alias of it (`static APP_HOLD_MAX = APP_HOLD_MAX;`), so a test that reads `Runtime.APP_HOLD_MAX` doesn’t change.
  - A closure that reads its enclosing function’s variables, such as a tool handler inside `toolsFor`, takes them as parameters instead. That’s the one rewrite beyond `this`, and the commit message names each parameter.
  - Module-level helpers and constants the moved code reads move with it, or go to a third module both files import. They’re never imported back from the old file: that’s a circular import, which means a missing module (developing.md, “Modules”).
  - The move is its own commit, with no other change. A reviewer checks it mechanically, by the recipe in designs/prompts/README.md, “Length limits”: undo the rewrite on the new module and diff it, ignoring whitespace, against the range the commit removed.
  - When several sessions move code out of one file at once, only the integrator lowers that file’s ceilings, once after each merge, in a commit of its own (designs/prompts/README.md, “Length limits”). One writer means no conflicts in `biome.json`, and a ceiling left loose for a while is safe, since nothing can grow past it.
- Later changes hold the moved code to its carried ceilings, like any other.

**Revisit when** the overrides are gone, or ceilings left loose after a file shrank become common: then a test that each ceiling equals its file’s size makes the lowering automatic.

## 16. Browser checks on Playwright Test

**Decision** (24 October 2026, #303). The headless browser checks move from the repo’s own runner (`tools/cdp.mjs`, `tools/harness.mjs`, `tools/check-all.mjs`) to Playwright Test, `@playwright/test`, a dev dependency at an exact version. New specs go in `tests/browser/*.spec.mjs`. The rest move one check at a time, and `check-all.mjs` runs those not yet moved. `tools/cdp.mjs` stays while the screenshot tools and the UAT driver use it.

**What it rests on**
- **The repo had rebuilt a test runner, and each part it lacked became a flake.**
  - Without focus emulation, one Escape left the page drawing no frames (#277).
  - Positions were read once after a fixed wait (#298), and a pointer-dwell gesture was used where the case needed none (#271).
  - Clicks landed under the sticky top bar or on a leftover backdrop.
  - Cases shared one page (#302), and Chrome’s version floated with the runner image (#301).
- **Playwright Test does each by default.**
  - Before a click it waits until the element is visible, stable for two frames, enabled, and the one under the pointer ([actionability](https://playwright.dev/docs/actionability)).
  - Its assertions retry until they pass.
  - Each test gets a fresh browser context ([browser contexts](https://playwright.dev/docs/browser-contexts)).
  - `--repeat-each`, `--only-changed` and `failOnFlakyTests` find flaky specs ([CLI](https://playwright.dev/docs/test-cli)).
  - Each version pins its own Chromium build.
- **Its strict locators caught what `querySelector` hid.** Porting the first two checks found three such things:
  - two top-bar rings for one agent (its own, and the one in the folded stack)
  - two menu buttons in a retired app’s item
  - a real bug: a menu closed before its deferred mousedown listener attached left that listener behind, and it closed every later menu on the press that picks an item (`openMenu` in `app/js/ui.mjs`). The old check clicked menu items with a script `click()`, so it never saw it.
- **A dev dependency, not a runtime one.** engineering-practices.md keeps runtime dependencies at zero; Biome, TypeScript and axe-core are dev dependencies already. CI downloads the pinned Chromium (`npx playwright install --with-deps chromium`).

**What stays Postbox’s own**
- **Each spec file starts its own Postbox** in its `beforeAll` (`tests/browser/postbox.mjs`): in the worker’s process, so a spec reaches its runtime and store; on a fresh data folder and a free port; with scripted agents. `synced()` waits for the page to hear the server.
- **`POSTBOX_STREAM_LAG`** is a server setting, so CI’s lag pass runs the specs too.
- **`failOnPageErrors(test)`** fails any test whose page threw or logged an error.
- **A Biome GritQL rule** (`tools/biome/no-fixed-waits.grit`) fails `npm run check` on `page.waitForTimeout` or `setTimeout` in a spec. Playwright’s own rule only lives in ESLint, which the repo doesn't use.

**How a spec is written**
- **Locators by role or name** where the page gives one, else by the attribute the code sets (`data-key`, `data-session`), never by position.
- **Web-first assertions** (`expect(locator)…`), `expect.poll` for anything else. A story whose steps build on each other is one test with `test.step`s and `expect.soft`.
- **Shown failing first.** A ported check is run against code without the fix it guards, as `needs-nav` was against the code before #285 (10 of 11 failed).

**Revisit when** the last check has moved: then `tools/harness.mjs` and `tools/check-all.mjs` go, and the remaining users of `tools/cdp.mjs` are reconsidered.
