# Developing

How to review a change to Postbox, and the JavaScript, Node, agent-backend, browser, security and testing rules that make “review it properly” a specific instruction.

This page sits beside three others, and repeats none of them:
- [engineering-practices.md](engineering-practices.md) is the gate and the per-tool rules (Node, Biome, TypeScript, the Agent SDK, the DOM, axe, Kokoro, tests, commits). Where a rule is already there, this page links to it.
- [architecture.md](architecture.md) records each engineering decision, what it rests on, and when to revisit it.
- [intent.md](intent.md) records the product decisions, and its “Writing” section governs every word this page asks you to write: plain American English, sentence case, curly quotes.

**No section here states a lint level.** `biome.json`, `jsconfig.json` and `package.json` are the authority, and a second copy goes stale silently. This page says what a green `npm run check` still lets through. Every external claim links to a source at the end, and each link there was fetched, not remembered.

Make simple, minimal changes, and don’t reinvent what already exists. In Postbox that means what Node and the browser ship (`node:test`, `node:crypto`, `AbortSignal.timeout`, `structuredClone`) and the helpers the repo already has (`h()` in `app/js/dom.mjs`, `shared/limits.mjs`, `tools/harness.mjs`), because a new runtime dependency needs a decision recorded in architecture.md first.

## Responding to a prompt

A prompt’s example of a defect is a symptom. Find the pattern and fix the cause, then look for the same class of error everywhere it could be:
- A bug in one adapter is a question about all of them. Postbox has five real backends (`claude-code`, `agent-sdk`, `kiro-cli`, `antigravity-cli`, `codex`) and the mock, so a refusal that doesn’t reach a card on one is checked on the other five.
- A defect the end-to-end UAT found is a check waiting to be written. When a check can catch the class, it goes into `tools/uat/checks.mjs`, as `refusal-without-card` and `settings-leak` did.
- A limit fixed in one place is fixed in all of them: the catalog, the event builder, the kit, the agent guide and the MCP tool descriptions all read `shared/limits.mjs` (#50).

## Proofreading

Review your own change from one level above the one that made it: an engineer’s code gets a senior engineer’s review, and a senior engineer’s design gets a principal’s. **Apply the standards of the language and the platform, not generic ones**, which is what the sections below exist to supply. “Is this idiomatic?” isn’t a finding until it names the idiom, and “add a test” isn’t one until it names the behavior the test would pin.

Organize the critique on three criteria, in this order:
1. **Correctness.** Does it work, and does it do what the issue asked? **Is every factual claim sourced?** A claim with no link, no fixture and no measurement is hearsay, so check that each link resolves, not just that it’s there. Does it name something that means nothing outside the session that wrote it? Does it hold up at the sizes Postbox is built for: the 20,000 events `server/store.mjs` keeps in memory (`KEEP_EVENTS`), and a table over the 1,000 rows above which architecture.md virtualizes?
2. **Consistency.** With intent.md and architecture.md, with the code around it, and with itself.
3. **Reasoning.** Can a reader get the intent and the behavior without a deep dive?

A comment like `// refuses here (see wave 2 prompt, step 4)` fails correctness: the prompt is rewritten every wave. Postbox’s comments point at what lasts: an issue number (`#126`), or a design section by its title (`designs/architecture.md, “The store”`), never by its number, since sections get renumbered. **The defect is a comment the reader can’t understand without following the link, not a comment that links.** Where a comment’s meaning rests on a line of code or a doc, link it with a GitHub permalink pinned to a commit and a line range (`/blob/<sha>/path#L10-L20`).

### Degenerate values are a defect until explained

**A suspiciously round, empty or uniform value is a finding about the harness until it’s shown to be a finding about Postbox.** Review stops on any of these and doesn’t go on until the value is explained in the artifact or fixed:

| Signal | What it usually hides |
|---|---|
| A count that’s exactly 0, or a run that found nothing | The thing was never exercised: no test file matched the glob, no check matched its name in `check-all`, the scenario never reached the phase |
| `0 passed, 0 failed.` from a headless check | Every case was skipped or the check crashed before its first `record()`; `harness.mjs` reports a crash as “the check ran to the end”, so look for that line |
| “Accessibility (axe-core): no violations” on a scene that rendered blank | axe checked an empty frame. Headless Chrome once passed every app while the Claude desktop app’s pane showed them blank (architecture.md, “Sandboxed pages that load nothing”) |
| A work ledger row with 0 lines, or a turn that cost $0.00 | The file tool’s result carried no `tool_use_result` (a subagent’s edit), or the turn’s last `result` was never read |
| Every agent in a report on the same model and effort | The runner’s default (`claude-haiku-5-5`, low) replaced the personas’ own, which is right for an integration pass and wrong for a measurement scenario |
| Screenshots that are identical across scenes or themes | The page never changed state, or the theme toggle never applied |
| A fixture with a field nobody has seen in a real stream | It was written by hand, not recorded |

**Three obligations, in order.** Say *why* the value is what it is, in the artifact and not only in a commit message. Then say whether it’s **sound for the claim being made**: a run with no agent turns is sound for a layout check and unsound for a streaming check. Then, if it isn’t sound, fix it rather than caveat it. A reader who quotes the headline won’t carry the caveat with it.

**A counter is not a readback.** Where the claim is that the *right* thing happened, the review asks what was read back and compared. A UAT report once said its agents ran at low effort while a `- models: persona` run kept each persona’s own: `run.json` recorded the runner’s flag, not what the agents were started with, and the report looked for an “Agents ran on” line the runner never writes (cdc3d4c). Both numbers were present; only reading back what ran told them apart.

**Say the degenerate case out loud where it will be read.** Put the fact that explains a suspicious number next to it, not three screens away.

**The same rule governs a green test run.**
- A test that passes against the mock adapter says the runtime’s plumbing works, not that a real backend does. A real backend is shown by a recorded fixture, and then by the end-to-end UAT.
- `npm test` runs `tests/*.test.mjs`. A file named anything else runs nowhere and exits 0, so check that the `tests` count in the summary went up by the number you added (540 as of v0.6.2).
- A claim that a change is clean names the command that proved it, and its exit code.

## What the gate enforces, and what it can’t

`package.json`’s `check` script is the list of what a green gate covers, and it’s narrower than the tools’ names suggest. engineering-practices.md, “The gate”, gives the order; this table gives the reach.

| Rule | Checked by |
|---|---|
| Lint and formatting in `app/js`, `app/kit/kit.js`, `app/kit/diagram.js`, `app/theme.js`, `server`, `shared`, `tools` and `tests` | Biome, with warnings as errors. `app/workbench.css`, `app/index.html` and `mockups/` aren’t in its `includes` |
| Types in `shared/` and `server/` | `tsc -p jsconfig.json`. `app/js/`, `tools/` and `tests/` aren’t type-checked at all, and `noImplicitAny` is off, so an untyped parameter is silently `any` |
| No raw colors outside the token blocks | `lint-tokens`, in CSS and JavaScript |
| No `innerHTML` without a named source; no attribute or style names chosen at run time | `lint-dom` |
| American spelling in strings, comments and these docs; curly quotes in what people read in the app | `lint-copy` |
| Every color pair in both themes, and on the app stage | `check:contrast` |
| Unit tests, with no network and no processes | `node:test` with `tests/guard.mjs` |
| Line coverage of the pure modules (the 90% target in architecture.md) | Nothing. `npm run test:coverage` reports it and fails on no threshold |
| Headless Chrome behavior | `npm run check:browser`, in CI’s end-to-end job, not in `npm run check` |
| No axe violations in any demo scene | `tools/shoot-app.mjs`, in CI’s end-to-end job |
| Conventional Commits | `tools/lint-commits.mjs` on a pull request in CI; the local hook only after `npm run hooks` |
| Real agents doing the right thing | The end-to-end UAT, which no CI job runs and which costs real usage |

**These stay review findings, because no checker expresses them:** a `catch` narrow enough to say what it handles; an error that tells a person what happened and what to do; a domain value given a union type instead of a `bool`; a switch that throws on the case it didn’t expect; a promise that’s awaited or handled; a child process with an `error` handler and a kill path; a branch on a structured field rather than on text; a lookup with `Object.hasOwn`; failing closed; a test that asserts a side effect didn’t happen; and a fixture that was recorded. Each is a judgment about a piece of code, not a pattern a linter can match.

### Running the gate

**Verify a change with `npm run check`, not with the commands it runs.** Its exit code is the one a claim of “clean” cites. Run one phase (`npm run lint`, `npm run typecheck`, `node --test --import ./tests/guard.mjs tests/store.test.mjs`) only to iterate on one failure, then run the whole gate again before you call the change done. A change you can see in the UI also passes `npm run check:browser` (`node tools/check-all.mjs <name>` to run some), and adds or extends a check that reports through `tools/harness.mjs`.

**Install the way CI does.** CI runs Node 22 and `npm ci --ignore-scripts`, so the optional packages never download their models or binaries. A result from a machine with `kokoro-js` or the Agent SDK installed, and CI without them, are two different environments, and a change that touches either path says which one it ran in.

**Use only your own ports and your own data.** Start a server with `--port` and `--data` of your own, and give headless Chrome `PB_PORT` and `PB_CHROME_PORT` from `ports()` in `tools/harness.mjs`. Never touch the preview on 4173, another tool’s server on 4320, or the person’s data: `~/.postbox`, which every run without `--data` shares, and a clone’s `data/`. Postbox refuses to start on a folder another Postbox is using, but `--fresh` without `--data` would still empty the person’s store. A check that talked to a server it didn’t start reports on someone else’s Postbox.

**The screenshot tools and the end-to-end UAT belong to the reviewing session** (`tools/shoot-app.mjs`, `tools/shoot-uat.mjs`, `tools/uat-run.mjs`). It runs them once per wave on the merged UI, as [prompts/README.md](prompts/README.md), “Rules for every session”, says.

**A check that passes needs a negative control before it counts.**
- A type check that reports nothing on a new file under `app/js/` checked nothing: that folder isn’t in `jsconfig.json`’s `include`.
- A new lint rule in `tools/lint-*.mjs` comes with a case in `tests/lint.test.mjs` that it flags.
- A new headless check or test for a bug is shown failing on the old code, when you can.

## JavaScript

Postbox is plain ES modules (`.mjs`), with JSDoc types, no build step and no framework (architecture.md, “The front end”). engineering-practices.md, “Node” and “TypeScript”, already covers imports, dependencies, spawning, timers, atomic writes, bounds, `any` and `Object.hasOwn`.

### Errors

**An error that can reach a person says what happened and what to do next** (intent.md, “Writing”). “Claude Code isn’t installed, or isn’t on the PATH. Install it, or set POSTBOX_CLAUDE_BIN.” is the model. A failed turn that says only “hit an error” can’t be fixed by anyone (#61). An HTTP error goes through `httpError(status, message)` in `server/runtime.mjs`, so the status and the sentence travel together.

**Keep the reason when you wrap.** `new Error(`Couldn’t read the snapshot at ${path}: ${e.message}`)` keeps it in the text, as `server/store.mjs` does. Where the original’s stack matters too, pass it as `{ cause: e }` ([`Error.cause`][mdn-error-cause]).

**Branch on `e.code`, never on the message.** Node’s system errors carry a stable `code` ([Node errors][node-errors]). `if (e.code !== 'ENOENT') throw …` in `store.mjs` survives a wording change; a match on `e.message` doesn’t.

**An empty `catch {}` is a decision, and its line says so.** There are about thirty in the repo, and each is defensible only where failure is the expected answer: `localStorage` unavailable, an optional file missing, a best-effort cleanup. Catching everything to make an error disappear is the swallowed reason engineering-practices.md forbids. When you can name the expected error, check for it and rethrow the rest.

**A library function throws; only an entry point calls `process.exit`.** The entry points are `bin/postbox.mjs` (the `postbox` command, which `node server/index.mjs` hands its flags to) and the scripts in `tools/` (`finish()` in `harness.mjs` is one). An exit code is a process-level decision, and a module that makes it can’t be tested.

**Give a shape a type.** When data has a known shape (an event, a block, a persona, a ledger entry), describe it with a `@typedef`, as `server/adapters/process-group.mjs` does for `Proc`, rather than passing `object` and probing it with `?.` in every caller.

### Types that refuse the wrong call

**A domain value gets a union of strings, not a `bool` or a bare `string`.** `state: 'think' | 'gen' | 'tool'` in JSDoc is checked; a `busy` flag plus a `thinking` flag is two booleans that can disagree. A boolean that really is the argument goes in an options object (`{ keep: true }`), so the call site reads.

**JavaScript has no exhaustiveness check, so a dispatch over a union ends in a throw.** A `switch` over block types, permission modes or ledger entry kinds closes with `default: throw new Error(`Unhandled ${value}`)`, not a silent fallthrough. A test that walks the list (the catalog’s block types, `EFFORT_LEVELS`, `PERMISSION_MODES`) pins that every one is handled, so adding a member forces a decision.

**Treat what an agent or app sends as `unknown` until it’s narrowed** (engineering-practices.md, “TypeScript”). The catalog validates blocks at the MCP boundary, so code past it can trust their shape; code before it can’t.

### Mutable state

**`shared/` is pure, and `shared/state.mjs` is the reducer both sides run.** The browser and the server apply the same events with it, so it reads no clock, no randomness and nothing from Node or the DOM. A timestamp or an id comes in on the event. Nothing in `shared/` imports `node:` today; keep it that way, since the browser loads those files as they are.

**A function either returns a new value or changes its argument, and its name says which.**

**Module state is process state.** engineering-practices.md covers the side that loses data on a restart (#18, #24). The other side is tests: a cached client or a module-level list makes two tests order-dependent. Pass the dependency in, as the `Store`, the `Runtime` and the adapters already take their spawn, fork, clock and folders.

### Lint and type-check exceptions

**Never silence a check to make the gate pass.** A failing check is a finding about the code, and the only answers are to fix the code or to argue in review that the rule is wrong, never to lower the bar in the change that tripped it. These are the same violation, and all of them are refused:
- A `biome-ignore` without a reason, or added to get past a failure rather than to record a decision.
- A `@ts-ignore` or `@ts-expect-error`. There are none in the repo; a boundary that needs a cast casts once, with a comment.
- A `lint-allow` or `lint-allow-file` without a reason. The tools require one, so an empty reason means the reason is being dodged.
- Turning a rule off in `biome.json`, or loosening `jsconfig.json`, in the same change that tripped it.
- Removing a path from Biome’s `includes` or `jsconfig.json`’s `include`, or adding one to an exclude, so the file stops being read.

**A real exception is narrow and says why.** `shared/urls.mjs` is the model: `// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters in a URL are exactly what this rejects`. It names the rule, sits on the one line, and tells the next reader whether it still applies. A rule turned off project-wide goes in `biome.json` with the reason in the commit (engineering-practices.md, “Biome”).

### Modules

**One concern per module, small enough to read in one sitting** (architecture.md, “The front end”). `server/runtime.mjs` and `app/js/thread.mjs` are already past that. A change that adds a concern to either moves it into its own module rather than growing the file.

**A circular import means a missing module.** The shared value belongs in a third module that neither imports back, which is usually `shared/`.

**Each test file is named for what it tests**: `tests/store.test.mjs` for `server/store.mjs`, so a reader finds a module’s tests on the first guess.

**`app/kit/vendor/` is never edited.** Mermaid, KaTeX and D3 are vendored with their licenses. A fix to one is an upgrade of the whole file.

## Async in Node and the browser

**Never block the event loop** ([Node’s guide][node-event-loop]). The server streams every agent’s reply through one loop, so a synchronous read of a big file, or a long computation, stalls every conversation at once. That’s why the store appends and snapshots asynchronously (architecture.md, “The store”).
- Bounded work that waits on I/O: use the `node:fs/promises` and `async` forms.
- A synchronous call is a deliberate exception and says why. The ledger reads a file synchronously the moment a tool call’s input is known, to win the race with the tool (architecture.md, “The work ledger”).
- Heavy or native work runs in its own process. Kokoro runs in a child process, never in the server (engineering-practices.md, “Narration”).

**Every promise is awaited, returned or handled.** Since Node 15, an unhandled rejection is raised as an uncaught exception and ends the process ([`--unhandled-rejections`][node-unhandled]). A fire-and-forget call gets a `.catch` that reports what failed. The timeout that rejected after the race was won (`tools/cdp.mjs`, d11c333) is the shape to look for.

**Every wait has a bound and a way out.** A fetch, a child process and a poll each carry an `AbortSignal` or a timer, and the timer is cleared or `unref()`’d. A turn honors `ctx.signal`, which Stop aborts. `AbortSignal.timeout(ms)` gives a fetch both at once ([MDN][mdn-abort-timeout]).

**Stop reaches the whole process group, and it’s been measured.** A CLI turn starts in its own process group (`detached: true`). Stop sends SIGINT to the group, then SIGKILL after `GRACE_MS`. Claude Code runs each Bash call in a session of its own, so its tool shells aren’t in that group, and `server/adapters/process-group.mjs` records with `ps` what each signal does to them (#126, #164). A change to Stop starts from that recording, not from what signals are supposed to do.

**A child process has three ways to end, and code handles all of them:** `error` (it never started), `exit` (it ended; its output may still be arriving) and `close` (its output is done). A turn ends on `close`, and a stopped turn on `exit` too, since a background job can hold the output open after its CLI is gone (`server/adapters/claude-code.mjs`, #126).

**In the browser, batch to the frame.** A streaming reply re-renders its Markdown once per animation frame, not once per text event. A live update resumes from the last sequence number it saw, so a reconnect loses and repeats nothing (architecture.md, “The store”).

## Agent backends

engineering-practices.md, “Building on Claude Code and the Agent SDK”, holds the rules for credentials, explicit settings, recorded streams, surfacing what the harness decides, and the agent guide. These add what a review checks across every backend.

**Everything that shapes a turn is passed in one place.** `server/adapters/setup.mjs` builds the setting sources, output style, denied tools, MCP config, model and effort. An adapter that adds a flag of its own beside it is a second place to keep in step, and the two will drift.

**Read what an adapter can do, not its name.** An adapter declares `capabilities` (`fork`, `permissions`, `models`, `tools`, `isolation`; see `server/adapters/adapter.mjs`, #117), and the runtime and the UI read those. An `if (adapter.name === 'kiro-cli')` is a capability nobody declared.

**A fixture is a real turn, with local paths removed, and it’s never edited to make a test pass.** `POSTBOX_CLAUDE_RECORD=<folder>` saves each turn’s raw stream; `POSTBOX_CODEX_RECORD` does the same for Codex. When the CLI changes shape, record a new fixture and say which version it came from, as `process-group.mjs` names claude 2.1.296. A hand-written line in a fixture is a guess wearing a recording’s name.

**Branch on structured fields.** A stream gives `type`, `subtype`, `permission_denials`, `tool_use_result`, `task_notification` and exit codes. Where it gives only text (a failed command’s result starts “Exit code N”), the parse is pinned by a recorded fixture, so a change in the text fails a test instead of a turn.

**Wait for the terminal event, and name it.** A turn isn’t over at the first `result`: a background command’s `task_notification` can arrive after it (architecture.md, “The work ledger”). Code that decides a turn is done names the events that end it and treats an unexpected one as a stop, not a retry.

**A real turn confirms what the docs promise.** The output-style override, the denied publishing tools and a turned-off MCP server were each confirmed by reading a real `init` event (architecture.md, “Real agents”). A change to what reaches a turn is confirmed the same way, and the pull request says what the `init` showed.

## Security

Postbox runs on your computer, as you, for one person. Its safety rests on a few boundaries, and a change that touches one of them is reviewed as a security change. Before any change to what Postbox listens on, who it answers, or what a page may load, read architecture.md, “Writes need the page’s token” and “Sandboxed pages that load nothing”, and its “Revisit when” lines.

**It answers this computer alone.** The server listens on 127.0.0.1, refuses a `Host` other than `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding) and a cross-site `Origin`, and every write needs the page’s token, compared in constant time (#74). `!` commands also refuse unless Postbox listens on loopback and the request came from this computer (#67). A change to the listen address is a change to all of these.

**Agent content is data.** It reaches the DOM as text through `h()`, and as HTML only from `renderMarkdown()` wrapped in `trusted()` (engineering-practices.md, “The DOM”). Agent apps run only in a page sandboxed by its `Content-Security-Policy` header ([CSP `sandbox`][mdn-csp-sandbox]), loading nothing from a URL, and the bridge answers only frames whose origin is `'null'`. Never `eval` or `new Function` agent text anywhere else.

**Every input is untrusted, including one from an agent’s own tool call.** Validate at the boundary and refuse rather than normalize, because normalizing approves one string and acts on another. `shared/urls.mjs` rejects a URL with control characters instead of stripping them. A file path is resolved with `realpath` and refused if it lands outside the folder it belongs to.

**Spawn with an argument array, never a shell string** ([child_process][node-child-process]). Git runs with `GIT_OPTIONAL_LOCKS=0` and is only ever read. The one place a shell is the point is a `!` command, which runs your own text, as you, behind the checks above.

**No secret in code, in a log, in a fixture or in a commit.** Postbox never handles an API key. A fixture has its local paths removed, and `data/`, `uat-runs/`, `.env` and `screenshots/latest/` stay out of git (`.gitignore`).

**Use `node:crypto` and nothing hand-rolled:** `randomBytes` for a token, `timingSafeEqual` to compare one, `createHash('sha256')` for a cache key.

**Count in integers.** Line counts, byte counts and sequence numbers are integers. Cost is the one float that’s summed. `total_cost_usd` is a running total for the process, so a turn’s spend is its last result’s, summed over the processes the turn ran, and it’s rounded only for display.

**Temporary files go where they’re cleaned up.** A test makes its folder with `mkdtemp(join(tmpdir(), 'pb-…'))` and removes it. A tool writes to an ignored folder (`screenshots/latest/`, `uat-runs/`, `check-logs/`), never into the tree.

## Tests

engineering-practices.md, “Tests”, covers speed, recorded fixtures, a failing test for each bug, UAT docs and new UAT checks. These are what a review checks inside a test.

**One behavior per test, named as a sentence.** `'a torn last line from a crash is dropped, and earlier events survive'` says what broke when it fails; `'load'` doesn’t.

**`assert.throws` and `assert.rejects` name what they expect** ([node:assert][node-assert]). Pass a regular expression for the message, or an object with `code` or `message`. A bare `assert.throws(fn)` passes on a typo in the code under test.

**Assert the side effect that must not happen, not only the error.** A test that a `!` command is refused off loopback can pass because the request failed earlier, on a missing token. The fake spawn records its calls, and asserting it was never called is what tells “refused” from “never got there”.

**Inject; don’t reach for process state.** Adapters take fake `spawn` and `fork`, the runtime takes a stub corpus and a `now`, and the server takes its home and data folders. `tests/guard.mjs` fails any test that touches the network or starts a process, so a test that needs one is a test that should have taken a fake.

**A fake is driven by a recording, and stays small.** Postbox fakes the process and the HTTP layer (`tests/fake-http.mjs`) rather than mocking its own modules. A hand-written fake keeps passing after the real interface changes, so the bytes it plays back come from a recorded fixture, which is what ties it to the real thing.

**Share setup; keep each action and its assertions inline.** A failing test should be readable without chasing three helpers, and logic moved into a shared helper is itself untested.

**Use `node:test` and `node:assert/strict`, and nothing else.** No test framework is a dependency, and `--experimental-test-coverage` is Node’s own ([node:test][node-test]).

**Add a test when the task covers it.** A new behavior, check or test matrix the issue didn’t ask for is added scope, and needs evidence and intent first (prompts/README.md, “Scope”).

## What ships is what to optimize for

Postbox ships as the repository: `npm start` runs `server/index.mjs`, and whatever that loads is the product. **A convenience that exists for a test or for the demo must not change what a real run does.**

Ask two questions of any test-only affordance:
1. **Does it ship?** A command-line flag, an environment variable and a default all ship. A fake under `tests/`, a dev dependency and a fixture don’t. `--demo`, `POSTBOX_BACKENDS=mock` and `POSTBOX_CLAUDE_RECORD` all ship.
2. **If it ships, what does a mistake do?** The answer that matters isn’t “the test passes” but “Postbox comes up wrong and says nothing”. The demo’s routes answer only when `demo` is set, and the server prints its backends at startup, so a run that came up on the mock says so. `POSTBOX_CLAUDE_RECORD` left set writes every turn’s stream, with your prompts, into a folder; that’s why it’s an opt-in that names its folder.

**The same rule holds for the gate.** CI runs the same `npm run check` you do. A rule worth failing locally fails in CI, and one that isn’t worth that is removed, not made local-only.

## Design habits

Each habit comes from a defect that cost a fix in Postbox or in an earlier service. They’re platform habits, not language rules.

1. **No speculative surface.** Don’t add a block field, an event field, an MCP tool parameter or a persona option that nothing reads yet. Whatever an agent can send gets validated and limited, and a field “for later” is something to validate now and migrate later. Add it when the feature lands.
2. **Fail loud over silent defaults.** A fallback that hides missing wiring turns a configuration bug into wrong behavior nobody sees. Postbox once let your own `effortLevel` and output style decide every agent turn (#57, #60); now both are always passed. Personas from before the `agents.outside` option existed are denied it, not granted it.
3. **Know whose settings you’re reading.** Anything that depends on the person’s setup (their Claude Code settings, MCP servers, global CLAUDE.md, home folder) is read on purpose, in one place, and a persona can opt out of it (Isolated). Tests never read the real one.
4. **Walk the whole chain in a new environment.** For a new backend, a new browser or a new listen address, trace the turn, the permissions, the stream and the rendering end to end before saying it works. Headless Chrome passed every sandboxed app while the desktop app’s pane refused them all (architecture.md, “Sandboxed pages that load nothing”).
5. **A test asserts what its name claims.** A test named for order asserts order. Every contract that lands (a limit, an MCP tool, a setting passed to a turn, a catalog block) lands with the test that pins it, as the test that fails when a limit is missing from the guide does.
6. **Check a dependency’s behavior before relying on it.** Read the documentation, the SDK’s shipped `sdk.d.ts`, or a real turn, and use the mechanism it gives. `noImplicitAny` is off and the optional SDK may not be installed, so `tsc` won’t tell you a call matches.
7. **Fix a defect you find, within the scope rule.** A bug in your own change is always yours. A defect you find in files you own, with evidence, is cheapest to fix in the session that found it. One outside them, or one that adds scope, is filed as an issue that carries its evidence, never left unsaid (prompts/README.md, “Scope”). “That was already broken” identifies a defect and leaves it there.

## Progress in living documents

Several of Postbox’s documents answer “where are we?”: [prompts/README.md](prompts/README.md) (waves and what’s merged), architecture.md’s “Where it stands”, intent.md’s “Quality bar”, and each UAT report’s coverage table. They answer it in prose, in tables and in diagrams, and a mark on one surface but not the others makes the document disagree with itself.

1. **Never mark done what doesn’t exist.** Check first: the pull request is merged, the command exits 0, the screenshot is committed. A reader trusts a mark over a sentence.
2. **Update the diagram in the same edit as the prose.** A Mermaid diagram is part of the document.
3. **Mark a diagram without redrawing it.** Use `classDef` and `class`, and leave every node, label and edge as the design drew them.
4. **One way of marking per document, with the meaning in words.** A colored node still says “merged” without its color (intent.md, principle 5).
5. **A progress mark isn’t a result.** “Built” and “measured” are different claims. Where a document records outcomes (a UAT report, a decision), that stays the only place they’re recorded.

State partial progress as partial: one of three pull requests merged isn’t a wave merged.

## Draw the relationship; don’t describe it

**A finding that reports a relationship draws it.** A relationship is what a single number isn’t:

| Shape | The figure that carries it |
|---|---|
| A flow between parts: a request, a turn, a stream | A Mermaid `sequenceDiagram` or `flowchart`, as architecture.md does for the page token and the ledger |
| A quantity against a scale: render time against thread length, defects found against run length | The measure against the scale, with log axes where the claim is separation |
| A threshold: diagram text under 10 px, contrast under 4.5:1 | The measured values with the threshold as a line |
| A comparison across more than about three cells: backends, scenarios, runs | Grouped bars or small multiples |

A single number, a pass or a fail, and a two-row comparison don’t get a figure. Neither does an invariant: a figure of a flat line invites a reader to look for a slope.

**Draw diagrams in Mermaid, and hold them to the bar agents are held to.** About five boxes side by side, top-to-bottom chains, short labels, and lists as text, not inside boxes (`shared/diagram-lint.mjs`, architecture.md, “Diagram legibility”). Avoid `<br/>` and numbered lists inside nodes.

**A chart or screenshot is generated, never edited.** It comes from a committed script that reads the artifact (`tools/uat-stats.mjs` for UAT runs, `tools/shoot-app.mjs` and `tools/shoot-uat.mjs` for screenshots), and it’s regenerated when the artifact changes. Approved screenshots live in `screenshots/`, and retakes go to `screenshots/latest/`.

**Then look at it.** A tool can prove a screenshot was taken and axe found nothing; it can’t tell you the scene is legible. Open it at both widths and in both themes.

## Code comments

**A JSDoc comment and a `//` comment answer different questions.** JSDoc states the interface: what the function does, its parameters and what it returns. A `//` comment states a *why* the code can’t state itself, and nothing else. Design rationale belongs in neither: it goes in architecture.md, as a decision, what it rests on, and when to revisit it.

**Start each module with what it is and the rule it keeps.** Postbox’s modules open that way: `server/store.mjs` says it’s an append-only log with an in-memory projection, says how a reconnecting browser loses nothing, and names its design section. A header that restates the file name tells the reader nothing.

**Don’t keep living documentation in a comment.** Nobody runs a comment, so it rots, and a reader trusts it without checking. What’s meant to outlive the change goes in a design doc, and the comment names the constraint in one line and links it. Link the design (architecture.md, intent.md), not a pull request or a UAT report: those record what one session found, and a comment that points at one asks every future reader to reconstruct the decision.

**Compressing a long comment isn’t a fix.** There are three fixes and no others: delete it, move it to the design doc and link it, or extract a function whose name says what the comment explained. A comment with no design to point at means the design was never written, and the answer is to write it.

**Don’t narrate what the code does.** This is the banned shape:

```js
// First we check whether the job is one the person kept. If it is, we don’t want to kill it,
// so we skip it. Otherwise we send SIGKILL to its group, because SIGINT may not have worked,
// and then we move on to the next one in the list.
```

One line carries the only fact a reader can’t get from the code:

```js
// Claude Code applies a leading `cd <dir> &&` itself, so match what the shell runs, not what it was given (#164).
```

**A `//` comment earns its place by being one of these:**

| Kind | What it records |
|---|---|
| A gotcha | A dependency behaving against expectation, with the version it was measured on, as `process-group.mjs` records claude 2.1.296 |
| A decision | The constraint, and the issue or design section behind it |
| A measured tradeoff | The number, and where the measurement lives |
| Work not done | `TODO(#NN):`, with the issue that tracks it. There are none in the repo today; a bare `// TODO` names no owner and outlives whoever wrote it |

**The claim and the link add up; neither replaces the other.** `// Stop sends SIGINT to the group first, so Claude Code stops its tool shells itself (#126)` stands on its own and carries a link. `// see #126` doesn’t.

**Prefer deleting a comment to shortening it, and a named function to either.** Read every comment you pass: one that no longer fits the code is fixed or removed, which is habit 7 applied to prose.

**Write comments in the same English as the UI.** American spelling (`lint-copy` checks comments too), curly quotes and apostrophes, and no lint level restated: the config is the authority.

## Commits and pull requests

engineering-practices.md, “Commits and versions”, holds the Conventional Commits rules and the release flow. prompts/README.md, “Rules for every session”, holds the branch, gate and hand-off steps. In short, and what a review checks:

**One commit per issue, with a body that says why.** `fix(stop): never kill a background job you chose to keep running` names the type, the scope and the change for the person. The body says why, ends with `Fixes #NN` (one per line, so each closes) and, when an agent wrote the change, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**A commit that is itself a record carries its record.** A fix found in review, or a change forced by a measurement, says what changed, what forced it and where that’s written down, as cdc3d4c does. Shortening it to one line deletes the record.

**Branch from `main`, stay based on it, and never push to it.** Every merge to `main` releases (`.github/workflows/release.yml`), so what reaches `main` is what people get.

**Answer review on the same branch, with new commits.** A force-push over commits a reviewer has commented on leaves their comments on code that’s no longer there. Fold fixup commits into the commit they fix before review, not after.

### The pull request’s body

Reviewers put off a change that looks large, so the body’s job is context, not an inventory. Decide what this reviewer has to judge, write that, and link the rest. Keep it under about 60 lines, reached by cutting content rather than rewording.
1. **Background:** why the change is happening. Link the issue and the design section.
2. **Details:** what changed, top-down: where in the architecture, then the specific parts. A small Mermaid `flowchart` or `sequenceDiagram` when the change crosses modules.
3. **Testing:** how it was verified. Name each command and its result (`npm run check`, `npm run check:browser`, the checks you added), and describe manual steps so a reviewer can replay them, down to the port and the message typed.
4. **Declined:** what the review raised that you didn’t take on, with the reason, or the issue you filed.

End it with “🤖 Generated with [Claude Code](https://claude.com/claude-code)” when an agent wrote it.

## Sources

Every external claim above links to one of these. Where one disagrees with `biome.json` or `jsconfig.json`, the config wins, and the disagreement is worth a line in the commit that set it.

[Conventional Commits][conventional-commits] is the commit format, and [WCAG 2.1][wcag21] is the accessibility target.

[conventional-commits]: https://www.conventionalcommits.org/en/v1.0.0/
[mdn-abort-timeout]: https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static
[mdn-csp-sandbox]: https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/sandbox
[mdn-error-cause]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error/cause
[node-assert]: https://nodejs.org/api/assert.html
[node-child-process]: https://nodejs.org/api/child_process.html
[node-errors]: https://nodejs.org/api/errors.html
[node-event-loop]: https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop
[node-test]: https://nodejs.org/api/test.html
[node-unhandled]: https://nodejs.org/api/cli.html#--unhandled-rejectionsmode
[wcag21]: https://www.w3.org/TR/WCAG21/
