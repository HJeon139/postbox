# Lints, the UAT runner and the screenshot tools: tools/

The root `AGENTS.md` applies here too.

## Browser checks

Browser checks are Playwright specs in `tests/browser/`: see `tests/AGENTS.md`, “Browser specs”. The UAT runner (`tools/uat-run.mjs`, `tools/uat/`) and the screenshot tools (`tools/shoot-app.mjs`, `tools/shoot-uat.mjs`) drive Playwright’s headless Chromium through `tools/browser.mjs`, which exits with them however they end (`tests/process/browser-kill.test.mjs`).

## Lints

`tools/lint-*.mjs` run in `npm run check`. A new rule comes with a case in `tests/lint.test.mjs` that it flags. An exception carries `lint-allow <rule>: <reason>` on its line (designs/architecture.md, “Code quality”).

## The UAT runner and the screenshot tools

- `tools/uat-run.mjs` runs real agents and costs real usage. `tools/shoot-app.mjs` and `tools/shoot-uat.mjs` take the screenshots. The demo’s go to `screenshots/latest/app/` and aren’t committed (CI’s artifact on `main` has the current ones); only the UAT docs’ `tests/uat/screenshots/` are, and the reviewing session commits those (designs/developing.md, “Screenshots”). Run them only when the task asks for them, or when you’re the reviewing session (designs/prompts/README.md, “Rules for every session”). axe on the demo’s scenes isn’t theirs: it’s a spec, `tests/browser/demo-a11y.spec.mjs`.
- Regular UAT runs are Claude only. A scenario with a Kiro, Codex or Antigravity agent is a compatibility run (`--compat`), and runs only when the task asks for it.
- When the UAT finds a defect class a check can catch, add the check to `server/room-checks.mjs`, through `tools/uat/checks.mjs`.
