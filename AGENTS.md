# Working on Postbox

Postbox is a local web app where one person directs two to four AI agents on their own computer: conversations, catalog blocks, sandboxed agent apps, and real backends (Claude Code, the Agent SDK, Kiro, Codex, Antigravity). Node with zero runtime dependencies, plain ES modules, no build step.

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
- Anything beyond the task needs evidence (a repro, a measurement, a UAT result, an issue, the person’s request) and a reason it serves designs/intent.md: one person directing two to four agents on their own computer, with the loop right before the looks. Otherwise decline it, or file it with its evidence (designs/prompts/README.md, “Rules for every session”).
- `tools/uat-run.mjs` runs real agents and costs real usage. Run it, and the screenshot tools (`tools/shoot-app.mjs`, `tools/shoot-uat.mjs`), only when the task asks for them, or when you’re the reviewing session (designs/prompts/README.md, “Rules for every session”).
- Make simple, minimal changes, and use what Node, the browser and the repo already have (`h()`, `shared/limits.mjs`, `tests/browser/postbox.mjs`). A new dependency needs a decision in designs/architecture.md first.

## Code size

- Biome fails a file or function past its default length. A file already past it has a ceiling in `biome.json` that only comes down (designs/architecture.md, “Module and function size”).
- When a change would grow a file at its ceiling, move a concern into a module of its own first, as its own commit, with nothing else in it. Never raise a ceiling. Give a new module past the default an override at its size, and don’t edit the override of a file you moved code from: the integrator lowers it after each merge (designs/prompts/README.md, “Rules for every session”).
- A circular import means a missing module: the shared value goes in a third module (designs/developing.md, “Modules”).
- Don’t reformat code you didn’t change. Never edit `app/kit/vendor/`.

## Writing

- Plain American English, sentence case and curly quotes (‘ ’ “ ”), in the UI, the docs and code comments. Buttons say what they do. Errors say what happened and what to do next (designs/intent.md, “Writing”). `lint-copy` checks American spelling everywhere, and curly quotes in what people read in the app; quotes in the docs are on you.
- Diagrams are Mermaid, never ASCII art (designs/engineering-practices.md, “Words, diagrams and commits”).
- A comment points at what lasts, an issue number or a design section by its title, never a prompt or a step number. It’s readable without following the link (designs/developing.md, “Code comments”).

## Commits, branches and pull requests

- Conventional Commits: `type(scope): what changed`, lowercase, the header within 100 characters. The body says why. `Fixes #n` goes on its own line, one per issue. `feat` bumps the minor version, `fix` the patch, and `type!` the major (designs/engineering-practices.md, “Commits and versions”). CI checks the messages and releases each merge to `main`.
- One commit per fix, so each can be reviewed and reverted alone. A move of code is its own commit.
- Branch from `main` and stay based on it. Don’t push to `main`.
- A pull request’s body says why, what changed, how it was verified, and what’s not done (designs/developing.md, “The pull request’s body”).
- When you take an issue for a pull request, claim it as CONTRIBUTING.md says: a comment, and the `in progress` label, or ask the maintainer to add it.

## Servers, ports and data

- Start Postbox only with a port and a `--data` folder of your own: `node server/index.mjs --port <yours> --data <a temp folder>`. Without `--data` it uses `~/.postbox` (or `$POSTBOX_HOME`), which every clone and worktree shares, or a clone’s own `data/` while that still holds conversations.
- Never touch the preview on 4173, another tool’s server on 4320, a clone’s `data/`, or `~/.postbox` (designs/developing.md, “Running the gate”).
- Never commit `data/`, `uat-runs/`, `.env`, anything under `screenshots/` that `.gitignore` leaves out, or anything with a secret. Postbox never reads, stores or passes an API key or token.

## Security boundaries

A change to any of these is reviewed as a security change (designs/developing.md, “Security”):
- Postbox listens on 127.0.0.1 only, and answers only requests addressed to `127.0.0.1` or `localhost` on its port. It refuses other `Host` headers and cross-site `Origin`s, and every write needs the page’s token (designs/architecture.md, “Writes need the page’s token”).
- Agent and app content is data. It reaches the DOM as text through `h()`, and as HTML only from `renderMarkdown()` wrapped in `trusted()`. Agent apps run only in CSP-sandboxed pages that load nothing (designs/architecture.md, “Sandboxed pages that load nothing”).
- Spawn processes with an argument array, never a shell string.
