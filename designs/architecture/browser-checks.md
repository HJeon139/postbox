# Browser checks on Playwright Test

Part of [the architecture](../architecture.md).

**Decision** (#303). The headless browser checks are Playwright Test specs, `@playwright/test`, a dev dependency at an exact version, in `tests/browser/*.spec.mjs`. They replaced the repo’s own runner (`tools/cdp.mjs`, `tools/harness.mjs`, `tools/check-all.mjs`), which is gone. The two checks that drive no browser run npm, git and an installed postbox, which `tests/guard.mjs` keeps out of the unit tests, so they’re `node:test` files in `tests/process/`, which `npm run check` runs. The demo’s accessibility gate is a spec too: `tests/browser/demo-a11y.spec.mjs` plays the demo’s scenes (`play()` in `tools/demo.mjs`) and runs axe-core on each, in both passes. `tools/shoot-app.mjs` only takes the screenshots, which CI uploads without failing on them.

## What it rests on

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
  - a real bug: a menu closed before its deferred mousedown listener attached left that listener behind, and it closed every later menu on the press that picks an item (`openMenu` in `app/js/ui.mjs`).
- **A dev dependency, not a runtime one.** engineering-practices.md keeps runtime dependencies at zero; Biome, TypeScript and axe-core are dev dependencies already. CI downloads the pinned Chromium (`npx playwright install --with-deps chromium`).

## What stays Postbox’s own

- **Each spec file starts its own Postbox** in its `beforeAll` (`tests/browser/postbox.mjs`): in the worker’s process, so a spec reaches its runtime and store; on a fresh data folder and a free port; with scripted agents. `synced()` waits for the page to hear the server.
- **`POSTBOX_STREAM_LAG`** is a server setting, so CI’s lag pass runs the specs too.
- **`failOnPageErrors(test)`** fails any test whose page threw or logged an error.
- **A Biome GritQL rule** (`tools/biome/no-fixed-waits.grit`) fails `npm run check` on `page.waitForTimeout` or `setTimeout` in a spec. Playwright’s own rule only lives in ESLint, which the repo doesn't use.

## How a spec is written

- **Locators by role or name** where the page gives one, else by the attribute the code sets (`data-key`, `data-session`), never by position.
- **Web-first assertions** (`expect(locator)…`), `expect.poll` for anything else. A story whose steps build on each other is one test with `test.step`s and `expect.soft`.
- **Wait for the condition, not a time.** `synced()` before a hash change, `frameLocator` clicks into an app’s frame, and a `toPass` aim that re-measures a pointer. Chromium under Playwright Test isn’t throttled in the background, and the lag pass runs every spec, so a coordinate click after a frame moved, a hash change before the page heard the server, or a pointer measured before its hover drew each failed there.
- **Widths against `windowWidth(page)`,** never `innerWidth`, which a page that overflows widens to fit, so a check against it can’t fail (#375).
- **Shown failing first.** A ported check is run against code without the fix it guards, as `needs-nav` was against the code before #285 (10 of 11 failed).

## The tools run the headless shell

The UAT runner and the screenshot tools use Playwright’s library too. `tools/browser.mjs` starts Playwright’s Chromium and gives them a page: its DevTools calls go over a CDP session, and an agent app’s frame is Playwright’s `Frame`. The reason is orphans:
- **A Chrome on a DevTools port outlived its parent.** An agent harness SIGKILLs a background job’s node at the end of its turn, and its Chrome lived on with no parent, holding memory, so successive UAT and screenshot runs piled them up.
- **Playwright drives Chromium over a pipe, and its headless shell exits when the pipe closes.** Chromium’s full headless mode, which the specs run (`channel: 'chromium'`), didn’t: with a page open it outlived its killed parent too (Chromium 156 on macOS). So the tools run the headless shell, with `--site-per-process`: without it the shell ran an agent app’s sandboxed frame in the page’s own process, where Chrome gives it one of its own.
- **`tests/process/browser-kill.test.mjs` SIGKILLs a run both ways `launch()` starts one,** and fails on `cdp.mjs` and on the full headless mode.
- **A pipe needs no port,** so parallel runs can’t collide on one.

**Revisit when** a Playwright upgrade changes what the kill test sees: if the full headless mode starts exiting with its pipe, the tools follow the specs onto it; if the headless shell stops, they need another way to end with their parent before they move.
