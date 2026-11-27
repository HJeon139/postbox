# Lints, the UAT runner and the screenshot tools: tools/

The root `AGENTS.md` applies here too.

## Browser checks

Browser checks are Playwright specs in `tests/browser/`: see `tests/AGENTS.md`, “Browser specs”. The UAT runner (`tools/uat-run.mjs`, `tools/uat/`) and the screenshot tools (`tools/shoot-app.mjs`, `tools/shoot-uat.mjs`) drive Playwright’s headless Chromium through `tools/browser.mjs`, which exits with them however they end (`tests/process/browser-kill.test.mjs`).

## Lints

`tools/lint-*.mjs` run in `npm run check`. A new rule comes with a case in `tests/lint.test.mjs` that it flags. An exception carries `lint-allow <rule>: <reason>` on its line (designs/architecture/code-quality.md, “Code quality”). `lint-ternary` takes only that line-level form, `lint-allow ternary: <reason>`, and no `lint-allow-file` (#753).

## The sign-off

`tools/signoff.mjs` (steps in `tools/signoff/`) and `tools/signoff-checks.mjs` are how a head is signed off (designs/developing.md, “Running the gate”, #845). Every effect of `tools/signoff.mjs` goes through the object `tools/signoff/deps.mjs` makes: commands, `gh`, the clock and timers, load, files, signals and the exit. That way, `tests/signoff.test.mjs` and the other `tests/signoff-*.test.mjs` drive every path with no real process. A new check comes with a test that fails without it. Every command runs through `exec` in `tools/signoff/wait.mjs`, which prints while it waits. It stays read-only towards GitHub.

## The UAT runner and the screenshot tools

- `tools/uat-run.mjs` runs real agents and costs real usage. `tools/shoot-app.mjs` and `tools/shoot-uat.mjs` take the screenshots. The demo’s go to `screenshots/latest/app/` and aren’t committed (CI’s artifact on `main` has the current ones); only the UAT docs’ `tests/uat/screenshots/` are, and the reviewing session commits those (designs/developing.md, “Screenshots”). Run them only when the task asks for them, or when you’re the reviewing session (designs/developing.md, “Rules for every session”). axe on the demo’s scenes isn’t theirs: it’s a spec, `tests/browser/demo-a11y.spec.mjs`.
- In a UAT, the person is whoever drives the page: the runner’s tester, through real clicks and typing, or you by hand. Never put an agent, persona or script in the room to play the person, the customer or the user: such a run doesn’t use the page, and its records describe a conversation no person had (tests/uat/e2e/README.md, “The person is whoever drives the page”).
- Regular UAT runs are Claude only. A scenario with a Kiro, Codex or Antigravity agent is a compatibility run (`--compat`), and runs only when the task asks for it. A batch UAT includes compatibility runs: each of its scenarios runs on every backend (designs/review-guide.md, “Batch UAT”).
- After every whole-window screenshot (`shotScreen`: each look step’s, and a failed action’s), the runner runs the layout check of `tools/text-layout.mjs` on the page and records what it found (`tools/uat/layout-probe.mjs`). The `text-layout` check (`tools/uat/checks-view.mjs`) turns each problem into a finding, and any one fails the run (`failsRun`, `tools/uat/checks-postbox.mjs`, #681). The browser specs run the same check through `tests/browser/text-layout.mjs`.
- When the UAT finds a defect class a check can catch, add the check to `tools/uat/room-checks.mjs`, through `tools/uat/checks.mjs`.
