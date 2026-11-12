# Browser checks on Playwright Test

Part of [the architecture](../architecture.md).

**Decision** (24 October 2026, #303). The headless browser checks move from the repo’s own runner (`tools/cdp.mjs`, `tools/harness.mjs`, `tools/check-all.mjs`) to Playwright Test, `@playwright/test`, a dev dependency at an exact version. New specs go in `tests/browser/*.spec.mjs`. The rest move one check at a time, and `check-all.mjs` runs those not yet moved. `tools/cdp.mjs` stays while the screenshot tools and the UAT driver use it.

**Done** (25 October 2026, #303). Every check is a spec in `tests/browser/`, except the two that drive no browser: they run npm, git and an installed postbox, which `tests/guard.mjs` keeps out of the unit tests, so they’re `node:test` files in `tests/process/`, which `npm run check` runs. `tools/check-all.mjs` and `tools/harness.mjs` are gone, with CI’s two steps for them. The demo’s accessibility gate moved too: `tools/shoot-app.mjs` ran axe-core on every scene it shot and failed CI on a violation, and now `tests/browser/demo-a11y.spec.mjs` plays the same scenes (`play()` in `tools/demo.mjs`) and runs axe on each, in both passes. `tools/shoot-app.mjs` only takes the screenshots, which CI still uploads without failing on them. `tools/cdp.mjs` stays only for the UAT runner (`tools/uat-run.mjs`, `tools/uat/`) and the screenshot tools (`tools/shoot-app.mjs`, `tools/shoot-uat.mjs`).

**What it rests on**
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
  - a real bug: a menu closed before its deferred mousedown listener attached left that listener behind, and it closed every later menu on the press that picks an item (`openMenu` in `app/js/ui.mjs`). The old check clicked menu items with a script `click()`, so it never saw it.
- **A dev dependency, not a runtime one.** engineering-practices.md keeps runtime dependencies at zero; Biome, TypeScript and axe-core are dev dependencies already. CI downloads the pinned Chromium (`npx playwright install --with-deps chromium`).

**What stays Postbox’s own**
- **Each spec file starts its own Postbox** in its `beforeAll` (`tests/browser/postbox.mjs`): in the worker’s process, so a spec reaches its runtime and store; on a fresh data folder and a free port; with scripted agents. `synced()` waits for the page to hear the server.
- **`POSTBOX_STREAM_LAG`** is a server setting, so CI’s lag pass runs the specs too.
- **`failOnPageErrors(test)`** fails any test whose page threw or logged an error.
- **A Biome GritQL rule** (`tools/biome/no-fixed-waits.grit`) fails `npm run check` on `page.waitForTimeout` or `setTimeout` in a spec. Playwright’s own rule only lives in ESLint, which the repo doesn't use.

**How a spec is written**
- **Locators by role or name** where the page gives one, else by the attribute the code sets (`data-key`, `data-session`), never by position.
- **Web-first assertions** (`expect(locator)…`), `expect.poll` for anything else. A story whose steps build on each other is one test with `test.step`s and `expect.soft`.
- **Shown failing first.** A ported check is run against code without the fix it guards, as `needs-nav` was against the code before #285 (10 of 11 failed).

**What the move found.** Chromium under Playwright Test isn’t throttled in the background, and the lag pass runs every spec. Both surfaced what the old runner had hidden:
- the transcript re-anchoring on its own scrolls, so a reply that grew while you read jumped the view (#297, `app/js/thread.mjs`);
- an app’s waiting card losing its agent’s needs-you at the end of any of that agent’s turns (`server/runtime.mjs`, `tests/apps-needs.test.mjs`);
- in the specs themselves: a coordinate click into an app’s frame after the frame moved, a page navigated by hash before it had heard the server, and a pointer measured before the hover it causes had drawn. Each is now a helper that waits for the condition (`synced()` before a hash change, `frameLocator` clicks, a `toPass` aim that re-measures).

- a check measuring a phone against `innerWidth`, which a page that overflows widens to fit, so it couldn’t fail: Settings’ tabs ran past a 375 px window behind one (fixed in #375). Specs measure against `windowWidth(page)`.

**Done** (25 October 2026). The UAT runner and the screenshot tools moved to Playwright’s library too, and `tools/cdp.mjs` is gone. `tools/browser.mjs` starts Playwright’s Chromium and gives them the page `cdp.mjs` did: its DevTools calls go over a CDP session, and an agent app’s frame is Playwright’s `Frame`. What moved them was orphans, not a change `cdp.mjs` couldn’t make:
- **A Chrome on a DevTools port outlived its parent.** An agent harness SIGKILLs a background job’s node at the end of its turn, and its Chrome lived on with no parent, holding memory, so successive UAT and screenshot runs piled them up.
- **Playwright drives Chromium over a pipe, and its headless shell exits when the pipe closes.** Chromium’s full headless mode, which the specs run (`channel: 'chromium'`), didn’t: with a page open it outlived its killed parent too (Chromium 156 on macOS). So the tools run the headless shell, with `--site-per-process`: without it the shell ran an agent app’s sandboxed frame in the page’s own process, where Chrome gives it one of its own.
- **`tests/process/browser-kill.test.mjs` SIGKILLs a run both ways `launch()` starts one,** and fails on `cdp.mjs` and on the full headless mode.
- **The UAT runner’s `--chrome-port` and the screenshot tools’ `PB_CHROME_PORT` went with it:** a pipe needs no port, so parallel runs can’t collide on one.

**Revisit when** a Playwright upgrade changes what the kill test sees: if the full headless mode starts exiting with its pipe, the tools follow the specs onto it; if the headless shell stops, they need another way to end with their parent before they move.
