# Unit tests, browser specs and UAT docs: tests/

The root `AGENTS.md` applies here too.

## Unit tests

`npm test` runs `tests/*.test.mjs` with `node:test`, loading `tests/guard.mjs` first. These come from designs/developing.md, “Tests”, and designs/engineering-practices.md, “Tests”:
- A file is named for the module it tests (`tests/store.test.mjs` for `server/store.mjs`). When that file is at its ceiling, add `tests/<module>-<concern>.test.mjs`. Every file ends in `.test.mjs`, or it runs nowhere and passes.
- One behavior per test, named as a sentence that says what broke when it fails.
- Deterministic and fast: no network, no processes, no real time. `tests/guard.mjs` fails any test that touches the network or spawns. Inject `now`, a fake `spawn`, and the home and data folders.
- `assert.throws` and `assert.rejects` name what they expect. Assert the side effect that must not happen, not only the error.
- Use `node:test` and `node:assert/strict` only. Fakes are small and driven by recorded fixtures, never hand-written stream lines.
- Share setup, but keep each action and its assertions inline in the test.
- Check that the suite’s test count went up by the tests you added.

A test that must run a real process (npm, git, an installed postbox) goes in `tests/process/*.test.mjs` instead, which `npm run test:process` runs without the guard, and `npm run check` runs too. It writes only to temp folders it makes and removes, and to nothing else it doesn’t put back (`npm pack` writes and removes `server/build-commit.txt` in the clone, and npm reads your own `~/.npmrc`). It runs on a port of its own, with a timeout on every process it starts, and stays a few seconds long.

## Browser specs

Browser checks are Playwright Test specs in `tests/browser/*.spec.mjs` (designs/architecture.md, “Browser checks on Playwright Test”, #303):
- Each spec file starts its own Postbox in `beforeAll` with `startPostbox()` from `tests/browser/postbox.mjs`, stops it in `afterAll`, and calls `failOnPageErrors(test)`. Wait for the page to hear the server with `synced(page, app)`.
- Wait with web-first assertions (`expect(locator)…`), `expect.poll` or `expect(…).toPass`, never for a fixed time. The `no-fixed-waits` Biome rule fails `page.waitForTimeout` and `setTimeout` in a spec.
- Find elements by role or name where the page gives one, else by the attribute the code sets (`data-key`, `data-session`). A locator that matches two elements is a question to answer, not to work around with `.first()`.
- Click and type as a person does, through Playwright. Never `element.click()` in the page: it skips the mouse, and a real bug hid behind one (#307).
- Read a position or a size only once it has stopped changing: `settled(page)` waits for the layout to hold still for two frames, then measure once (#298).
- Measure what fits a narrow window against `windowWidth(page)`, never `innerWidth`. On a phone (`isMobile`), a page that overflows widens `innerWidth` to fit, so a check against it can’t fail. Settings’ tabs ran past a 375 px window behind one.
- A test that holds what were separate checks makes its expects soft (`expect.soft`), so each reports whichever fails first.
- Tests that don’t depend on each other stay independent; a story whose steps build on each other is one test with `test.step`s and `expect.soft`.
- Show a new spec failing on the code without its fix. CI runs a spec a pull request adds or changes ten times, with the events late.

## UAT docs

- Each UI change gets a doc under `tests/uat/`: why the component exists, what it should do, steps to reproduce, and what passes. Update the docs your change affects. Don’t refresh their screenshots; the reviewing session does that (designs/prompts/README.md, “Rules for every session”).
- The end-to-end scenarios live in `tests/uat/e2e/scenarios/`. A targeted scenario names the triggers each phase must cause (`tests/uat/e2e/README.md`).
