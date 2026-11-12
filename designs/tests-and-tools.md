# Tests, tools and the repository

What `npm run check` runs, the other parts of the gate, the tools in `tools/`, and where things are in the repository. The rules a change is held to are in [engineering-practices.md](engineering-practices.md) and [developing.md](developing.md).

## Tests and tools

```bash
npm run check
```

That runs, in order:
- **Biome:** lint and formatting.
- **TypeScript:** types from JSDoc in `shared/` and `server/`, with no build.
- **Project rules:**
  - `lint-tokens`: no raw colors outside the token blocks
  - `lint-dom`: no unsafe HTML or agent-named attributes and styles
  - `lint-copy`: American spelling and curly quotes
  - `lint-security`: the code rules in [SECURITY.md](../SECURITY.md)
  - `lint-caps`: no change raises a length ceiling in `biome.json`
  - `lint-ternary`: no new nested ternary on a changed line
- **Contrast:** every token pair in both modes.
- **Unit tests** (`npm test`): the `node:test` files in `tests/`. Each loads [`tests/guard.mjs`](../tests/guard.mjs) first, which fails any test that touches the network or starts a process.
- **Integration tests** (`npm run test:integration`): the files in [`tests/integration/`](../tests/integration/), which run the remote host’s programs as real local processes over pipes and Unix sockets, never the network. Where a test stands in for ssh, it runs the remote command on this machine with `/bin/sh -c` and a temporary home folder, so nothing touches your own `~/.postbox-remote`. A test that needs Linux (`/proc`, logind) skips elsewhere and says why.
- **Process tests** (`npm run test:process`): the files in [`tests/process/`](../tests/process/), which start real processes, Chromium, `npm` and `git`.

They cover:
- the block validator, the Markdown renderer and the event builder
- mentions, finished-sentence announcements, URL checks and BM25 search
- the store: the event log, crash recovery, snapshots and blobs
- the runtime: queueing, Stop, failures and Retry, needs-you, the wake limit, side threads, topic threads, delete, app permissions, the check-and-fix loop, permission cards and MCP
- every real adapter, replaying streams recorded from real turns ([`tests/fixtures/claude-code/`](../tests/fixtures/claude-code/), [`codex-app-server/`](../tests/fixtures/codex-app-server/), [`kiro-cli/`](../tests/fixtures/kiro-cli/) and [`antigravity-cli/`](../tests/fixtures/antigravity-cli/))
- the work ledger: line counts against git’s, recorded turns that edit, commit, push and run background commands, where git says each change stands, and Restore
- the diagram linter, against text sizes measured in Chrome
- attaching and mirroring Claude Code sessions, narration, and the lint rules themselves
- remote hosts, in the integration tests: the install script and the `host` launcher; the daemon, the turn runner and the stdio shim; and a remote Claude Code turn through the whole pipeline, with only ssh replaced, across an ssh drop, a killed daemon, a Postbox restart, Stop, an expired prompt and an interrupted turn. Also the idle exit and Remove, after which nothing of Postbox’s own is left on the host (the agents’ working folders stay), and no TCP listener on either side during a turn

Continuous integration ([`.github/workflows/check.yml`](../.github/workflows/check.yml)) runs the same check on every pull request, then plays the demo in headless Chrome and runs axe-core on every scene. It also checks that a pull request’s commit messages follow Conventional Commits, and that every change on main is released.

The rest of the gate is in [AGENTS.md](../AGENTS.md), “The gate”:
- **Browser specs** (`npx playwright test`): the Playwright specs in [`tests/browser/`](../tests/browser/), each file on a Postbox of its own, run again with `POSTBOX_STREAM_LAG=300`, as CI runs them.
- **UAT:** the component docs in [`tests/uat/`](../tests/uat/), checked by hand against the demo, and the end-to-end scenarios with real agents (`npm run uat`, [tests/uat/e2e/README.md](../tests/uat/e2e/README.md)), which cost real usage.

| Command | What it does |
|---|---|
| `postbox [--port 4173] [--data <folder>] [--fresh] [--demo] [--move-data] [-v]` | The same as `npm start` or `node server/index.mjs` in a clone. Runs Postbox, with its data in `~/.postbox` unless `POSTBOX_HOME` or `--data` says otherwise. A fresh install seeds three agents: @researcher, @developer and @critic. `--demo` seeds the demo’s agents, projects and conversations instead, enables the demo controls and uses the mock only. `--move-data` moves a clone’s `data/` to `~/.postbox` and exits; `-v` prints the version. |
| `node tools/demo.mjs [--port] [--speed] [--story showcase]` | Plays every block and error state on a fresh Postbox; `--story showcase` plays the replays of real recorded sessions in `tools/demo/showcase/` instead |
| `node tools/readme-gif.mjs [--port] [--keep]` | Records the README’s GIF and its two stills from the showcase’s replays (needs ffmpeg) |
| `node tools/shoot-app.mjs [--baseline]` | Plays the demo in headless Chrome and screenshots every scene at 375 and 1280 px in both modes. axe-core checks the same scenes in `tests/browser/demo-a11y.spec.mjs` |
| `node tools/contrast.mjs [css]` | Checks WCAG contrast for every token pair, in both modes and on the app stage (`app/workbench.css` unless you name another) |
| `npm run format` | Applies Biome’s formatting and safe fixes |
| `npm run test:integration` | Runs only the integration tests in `tests/integration/` |
| `npm run test:coverage` | Runs the tests with coverage for `shared/`, `server/` and the lint rules |
| `npm run release [-- --dry-run]` | Releases the next semantic version from the commits since the last tag: package.json, CHANGELOG.md, a release commit and a tag. CI runs it after each merge to main (`.github/workflows/release.yml`) |
| `npm run lint:commits [range]` | Checks commit messages against Conventional Commits |
| `npm run hooks` | Turns on the git hooks in `.githooks/`, and names any hook of your own in `.git/hooks`, or other `core.hooksPath`, that git stops running: `commit-msg` checks each commit message as you write it, and `pre-commit` runs `npm run lint:project` and stops a commit it fails (only the person skips them, with `git commit --no-verify`, in an emergency; an agent fixes the failure and commits again) |

The demo’s screenshots go to `screenshots/latest/`, which git ignores, and aren’t committed. For the current ones, open the `screenshots` artifact of the latest `check` run on `main`, or run `node tools/shoot-app.mjs`.

## Repository layout

```text
bin/          the postbox command
app/          the browser app: index.html, workbench.css (the one stylesheet), js/ modules, kit/ for app sandboxes
server/       Node server, runtime, store, blobs, assets, MCP, sandbox pages
  adapters/   mock, Claude Code, Agent SDK, Kiro CLI, Antigravity CLI, Codex, the shared guide and stream mapper, the terminal mirror
  remote/     remote hosts: the ssh link, install, and host/, the daemon and turn runner that run there
  personas/   the seeded agents’ instructions
  view-app/   view_app: a picture of an agent’s app, in a pinned headless browser
  narration/  the Kokoro narrator and its worker process
  mock/       the mock agent’s apps
  demo-assets/ the notes --demo publishes as assets
shared/       pure modules used by both sides: catalog, Markdown, events, state, BM25, text helpers
agent-plugin/ the skills Postbox gives its agents
tests/        node:test suites, and fixtures recorded from real turns
  browser/    Playwright specs
  integration/ the remote host’s programs as real local processes
  process/    tests that start real processes, npm and git
  uat/        the UAT docs, and e2e/, the end-to-end scenarios with real agents
tools/        demo, UAT runner, screenshot tools, contrast checker, project lint rules
designs/      product intent, architecture decisions, engineering practices and recipes
screenshots/  generated pictures (git ignores them)
```

Third-party code shipped with the app is limited to the vendored libraries in `app/kit/vendor/` (Mermaid, KaTeX and D3, each with its license). The optional packages (the Agent SDK and Kokoro) and the development tools (Biome, TypeScript and axe-core) install with `npm install` and are never needed to run the mock.
