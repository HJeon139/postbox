# Working on Postbox

Postbox is a local web app where one person directs a team of AI agents on their own computer: conversations, catalog blocks, sandboxed agent apps, and real backends (Claude Code, Kiro, Codex, Antigravity). Node with zero runtime dependencies, plain ES modules, no build step.

Its value is one loop: the person configures an agile team of agents to their vision, walks away while the team builds and holds each other to the definition of done, and comes back to a working implementation with its evidence: the review record, the test results and the version history. Function comes first; anything that isn’t part of that loop works against Postbox (designs/intent.md, “Purpose” and “Function first”).

These are the rules every change follows, whoever writes it. Each names the design section that explains it. When a rule and its section disagree, fix both in the same change. A rule here is guidance; what CI checks (the gate, below) is what holds.

## More rules in each folder

Before you change files in a folder, read its `AGENTS.md` too. Some tools load it on their own, and some only load this one.
- `app/AGENTS.md`: the client. DOM, agent content, tokens, accessibility, motion.
- `server/AGENTS.md`: the server and the agent backends. Node, errors, adapters, security boundaries.
- `tests/AGENTS.md`: unit tests, the browser specs, and UAT docs.
- `tools/AGENTS.md`: the lints, the UAT runner and the screenshot tools.
- `designs/AGENTS.md`: writing and updating the design docs.

## The gate

```bash
npm run check            # Biome, types, project lints, contrast, unit tests, and the tests that run npm and git
npx playwright test      # the browser specs in tests/browser/
POSTBOX_STREAM_LAG=300 npx playwright test   # with the server’s events 300 ms late, as CI runs it
```

- A change is done when `npm run check` exits 0. A change you can see in the UI also passes both browser runs, and adds or extends a browser spec in `tests/browser/` (designs/engineering-practices.md, “The gate”).
- Cite the command that proved a claim, and its exit code. A count of exactly 0, or a run that found nothing, is a finding about the harness until it’s explained (designs/developing.md, “Degenerate values are a defect until explained”).
- Show a test or spec failing on the code without the fix, when you can (designs/engineering-practices.md, “Tests”).

## Scope

- Fix the cause and look for the same class of error everywhere: a bug in one adapter is a question about all of them (designs/developing.md, “Responding to a prompt”).
- Anything beyond the task needs evidence (a repro, a measurement, a UAT result, an issue, the person’s request) and a reason it serves designs/intent.md: one person directing a team of agents on their own computer, who work together without waiting on the person, with the loop right before the looks. Otherwise decline it, or file it with its evidence (designs/developing.md, “Rules for every session”).
- Function first: a refusal, limit or approval that costs agents or their apps function needs a real risk, and says what it protects against. New app access follows the grant its agent sets, within that agent’s own tools (planned, #1610: today every agent’s apps hold `net.fetch`); a confirm before something destructive or costly stays (designs/intent.md, “Function first”; designs/developing.md, “Design habits”, 13).
- Don’t add a card, confirm, warning, notice or limit that waits on the person or asks for their attention unless only they can make the decision it carries, and the harness’s own check isn’t enough. Show what agents did instead (designs/developing.md, “Design habits”).
- No unactionable alarms: what the person can’t act on (a tool call the agent retries or works around, a change an agent made) never raises “needs you”, a blocking notification, a focus move or an acknowledgment button. A notice appears when the change happens, never on a click meant for something else, and never moves a button under the pointer (designs/developing.md, “Design habits”, 12).
- `tools/uat-run.mjs` runs real agents and costs real usage. Run it, and the screenshot tools (`tools/shoot-app.mjs`, `tools/shoot-uat.mjs`), only when the task asks for them, or when you’re the reviewing session (designs/developing.md, “Rules for every session”). In a UAT the person is whoever drives the page, the runner’s tester or you in a browser, never an agent in the room (tests/uat/e2e/README.md, “The person is whoever drives the page”).
- Make simple, minimal changes, and use what Node, the browser and the repo already have (`h()`, `shared/limits.mjs`, `tests/browser/postbox.mjs`). A new dependency needs a decision in a child of designs/architecture.md first.

## Code size

- Biome fails a file or function past its default length. A file already past it has a ceiling in `biome.json` that only comes down, and `tools/lint-caps.mjs` fails a change that raises one (designs/architecture/code-size.md, “Module and function size”).
- When a change would grow a file at its ceiling, move a concern into a module of its own first, as its own commit, with nothing else in it. Never raise a ceiling. A new module gets no override over the default: split moved code under it in the same pull request, after the move commit. Don’t edit the override of a file you moved code from: the integrator lowers it after each merge (designs/developing.md, “Rules for every session”).
- The limits are for the reader, not a line count to hit. Simplify first, then split by concern: each file owns one thing you can name, and one decision reads in one place. Never compress code (joined lines, dense one-liners, dropped names or comments) or cut one decision across files to fit a limit. Review fails both, even when Biome passes them (designs/architecture/code-size.md, “Module and function size”, its “What a split is for”).
- A circular import means a missing module: the shared value goes in a third module (designs/developing.md, “Modules”).
- Don’t reformat code you didn’t change. Never edit `app/kit/vendor/`.

## Writing

- Plain American English, sentence case and curly quotes (‘ ’ “ ”), in the UI, the docs and code comments. Buttons say what they do. Errors say what happened and what to do next (designs/intent.md, “Writing”). `lint-copy` checks American spelling everywhere, and curly quotes in what people read in the app; quotes in the docs are on you.
- Diagrams are Mermaid, never ASCII art (designs/engineering-practices.md, “Words, diagrams and commits”).
- A comment points at what lasts, an issue number or a design section by its title, never a prompt or a step number. It’s readable without following the link (designs/developing.md, “Code comments”).

## Commits, branches and pull requests

- Conventional Commits: `type(scope): what changed`, lowercase, the header within 100 characters. The body says why. `Fixes #n` goes on its own line, one per issue. `feat` bumps the minor version, `fix` the patch, and `type!` the major (designs/engineering-practices.md, “Commits and versions”). CI checks the messages and releases each merge to `main` once `main`’s checks pass on it.
- One commit per fix, so each can be reviewed and reverted alone. A move of code is its own commit.
- Branch from `main` and stay based on it. Don’t push to `main`.
- Run `npm run hooks` when you set up a clone or a worktree. It turns on `.githooks/commit-msg`, which checks each message, and `.githooks/pre-commit`, which runs `npm run lint:project` and stops a commit it fails. See designs/developing.md, “Running the gate”.
- A pull request’s body says why, what changed, how it was verified, and what’s not done (designs/developing.md, “The pull request’s body”).
- When you take an issue for a pull request, claim it as CONTRIBUTING.md says: assign yourself (`gh issue edit <n> --add-assignee @me`) and comment, or comment and ask the maintainer to assign you.

## Servers, ports and data

- Start Postbox only with a port and a `--data` folder of your own: `node server/index.mjs --port <yours> --data <a temp folder>`. Without `--data` it uses `~/.postbox` (or `$POSTBOX_HOME`), which every clone and worktree shares, or a clone’s own `data/` while that still holds conversations.
- Never touch the preview on 4173, another tool’s server on 4320, a clone’s `data/`, or `~/.postbox` (designs/developing.md, “Running the gate”).
- Stop whatever you start in the background by its process ID (`$!`), never by job number (in a subshell, `kill %1 %2` can miss one without a word), and check nothing is left before you report. Never `pkill` or `killall` by name (designs/developing.md, “Running the gate”).
- Never commit `data/`, `uat-runs/`, `.env`, anything under `screenshots/` that `.gitignore` leaves out, or anything with a secret. Postbox never reads, stores or passes an API key or token.

## Security boundaries

A change to any of these is reviewed as a security change (designs/developing.md, “Security”):
- Postbox listens on 127.0.0.1 only, and answers only requests addressed to `127.0.0.1` or `localhost` on its port. It refuses other `Host` headers and cross-site `Origin`s, and every write needs the page’s token (designs/architecture/security-boundaries.md, “This computer alone”). Only `--hosted <settings file>` changes that: then it listens on every address, answers only the one public origin the file names, takes every request, reads included, only from someone its load balancer signed in who is on the allow list, and answers `/health` alone without one (designs/architecture/hosted.md, “The address it answers” and “Who is asking”).
- Agent and app content is data. It reaches the DOM as text through `h()`, and as HTML only from `renderMarkdown()` wrapped in `trusted()`. Agent apps run only in CSP-sandboxed pages that load nothing themselves (designs/architecture/sandbox.md, “Sandboxed pages that load nothing”).
- An app reaches the network only through `net.fetch` on Postbox’s server: GET, no cookies, no redirects, no environment proxy, and never a private, loopback or link-local address in any spelling, checked by `BlockList` before and after DNS resolution. Planned (#1610), not built: a grant its agent sets opens the sources it names, the person’s network and folders on disk (`fs.read`), within the agent’s own tools, and never credential locations, cloud metadata or another Postbox; reads of Postbox’s API will need the page’s token. Code to the built rule until #1610 lands (designs/architecture/security-boundaries.md, “What leaves through net.fetch” and “What an app reads from disk”).
- Spawn processes with an argument array, never a shell string.
- What reaches the browser is decided by the `public` flag in `EVENTS` and the state-key lists in `shared/state.mjs`. `/api/state` and the event stream (the live and backlog frames) go through `server/public-state.mjs`. Every other route that answers with state may carry only data of public keys: review holds that until A2 adds a check that holds it. The private keys, `published` (#1478) and `appNotes` (#1488), have their own checks: only `server/app-publish.mjs` reads the first and `server/app-notes.mjs` the second, and `tests/published-kept-out.test.mjs` finds neither in any answer a page or a host gets (designs/architecture/security-boundaries.md, “What reaches the browser”).
