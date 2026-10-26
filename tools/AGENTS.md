# Lints, the UAT runner and the screenshot tools: tools/

The root `AGENTS.md` applies here too.

## Browser checks

Browser checks are Playwright specs in `tests/browser/`: see `tests/AGENTS.md`, “Browser specs”. `tools/cdp.mjs` drives Chrome only for the UAT runner (`tools/uat-run.mjs`, `tools/uat/`) and the screenshot tools (`tools/shoot-app.mjs`, `tools/shoot-uat.mjs`).

## Lints

`tools/lint-*.mjs` run in `npm run check`. A new rule comes with a case in `tests/lint.test.mjs` that it flags. An exception carries `lint-allow <rule>: <reason>` on its line (designs/architecture.md, “Code quality”).

## The UAT runner and the screenshot tools

- `tools/uat-run.mjs` runs real agents and costs real usage. `tools/shoot-app.mjs` and `tools/shoot-uat.mjs` refresh the screenshots and run axe. Run them only when the task asks for them, or when you’re the reviewing session (designs/prompts/README.md, “Rules for every session”).
- Regular UAT runs are Claude only. A scenario with a Kiro, Codex or Antigravity agent is a compatibility run (`--compat`), and runs only when the task asks for it.
- When the UAT finds a defect class a check can catch, add the check to `server/room-checks.mjs`, through `tools/uat/checks.mjs`.
