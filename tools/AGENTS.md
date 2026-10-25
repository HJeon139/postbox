# Browser checks, lints and the UAT runner: tools/

The root `AGENTS.md` applies here too.

## Headless browser checks

New browser checks are Playwright specs: see `tests/AGENTS.md`, “Browser specs”. The older `tools/check-*.mjs` and `tools/checks/*.mjs` drive headless Chrome through `tools/cdp.mjs`, and `tools/check-all.mjs` runs them all (designs/engineering-practices.md, “The gate”). #303 moves them to Playwright one at a time: a ported check keeps every case, is shown failing on the code without its fix, and its old file goes. Until a check moves, these rules hold for it:
- Report through `tools/harness.mjs`: `ports()`, then `record()` for each case, then `finish()`. A check that records nothing fails.
- Use the ports and data folder `ports()` gives you. Never a server you didn’t start (designs/developing.md, “Running the gate”).
- Wait on a condition, never a fixed time. `page.synced(store.state.seq)` waits for the page to hear the server; poll anything else within a time budget. A sleep is only for asserting that something did _not_ happen. Read a position or size only once it has stopped changing (#298).
- Click with the mouse at an element you have scrolled to the center, so the sticky top bar can’t cover it. Use the element a person would use, not the first match `querySelector` finds.
- Leave the page as you found it: close dialogs, menus and hover cards at the end of each case (#302).
- Run each check you add or change with `--lag 300`, and show it failing on the code without the fix.

## Lints

`tools/lint-*.mjs` run in `npm run check`. A new rule comes with a case in `tests/lint.test.mjs` that it flags. An exception carries `lint-allow <rule>: <reason>` on its line (designs/architecture.md, “Code quality”).

## The UAT runner and the screenshot tools

- `tools/uat-run.mjs` runs real agents and costs real usage. `tools/shoot-app.mjs` and `tools/shoot-uat.mjs` refresh the screenshots and run axe. Run them only when the task asks for them, or when you’re the reviewing session (designs/prompts/README.md, “Rules for every session”).
- Regular UAT runs are Claude only. A scenario with a Kiro, Codex or Antigravity agent is a compatibility run (`--compat`), and runs only when the task asks for it.
- When the UAT finds a defect class a check can catch, add the check to `server/room-checks.mjs`, through `tools/uat/checks.mjs`.
