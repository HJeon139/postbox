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

A test that must run a real process (npm, git, an installed postbox) goes in `tests/process/*.test.mjs` instead, which `npm run test:process` runs without the guard, and `npm run check` runs too. It writes only to temp folders it makes and removes, and to nothing else it doesn’t put back (`npm pack` writes and removes `server/build-commit.txt` in the clone). It reads none of your own config: the install test gives npm an empty config file of its own. It runs on a port of its own, with a timeout on every process it starts, and stays a few seconds long.

## The store’s Redis

The store is a Redis 8 child process (server/redis-supervisor.mjs; #508’s design, “Storage: a Redis 8 server that Postbox bundles and runs”). Postbox downloads its own pinned build at first start; for development and tests, `POSTBOX_REDIS_HOME` names a Redis 8 build with the JSON and search modules instead, either a Postbox package (`bin/redis-server`, `modules/rejson.so`, `modules/redisearch.so`) or a Redis 8 source tree built with `make BUILD_WITH_MODULES=yes` (`src/redis-server`, `modules/redisjson/rejson.so`, `modules/redisearch/redisearch.so`). `npm run check` and the browser specs need it set: `POSTBOX_REDIS_HOME=/path/to/redis-8.10.3 npm run check`. CI’s runners have no Redis, so each job of `.github/workflows/check.yml` runs `node tools/redis-ci.mjs prepare`, which gets the pinned build from Postbox’s own release through the code first start runs (server/redis-download.mjs keeps it only once its SHA-256 matches server/redis-build.mjs; server/redis-unpack.mjs unpacks it in Node) and writes `POSTBOX_REDIS_HOME` to `$GITHUB_ENV`; the verified archive is cached under its pinned SHA-256 and hashed again on every run. Locally, `node tools/redis-ci.mjs prepare <folder> [archive]` does the same, from a release asset already on disk.
- Specs of the child itself (it starts, dies, restarts, exits) run real processes, so they’re in `tests/process/`.
- A test that kills a store’s child does it with `killed(store)` (`tests/store-kill-fixture.mjs`, also exported by `tests/store-fixture.mjs`), never `sup.child.kill` followed by a bare `await` of its exit or the next status. Once the child runs, nothing of it keeps the event loop alive (the supervisor unrefs it, its pipes and an idle connection), so a loop with only that wait in it ends before the kernel reports the death: Node exits, and node:test cancels every pending test with “Promise resolution is still pending but the event loop has already resolved”, naming no cause. Linux does that every time; macOS hid it. `killed` holds the loop and fails naming the supervisor’s status. A kill that something ref’d follows in the same tick (a `setTimeout` poll, a pending reply) is safe. Waits on the store go through the fixture’s `until(pred, what, store)`, which names the condition and the Redis status when it times out, so a child that doesn’t come back fails there, with its cause. A promise rather than a condition (a gate the restarted child’s catch-up reaches, `retry(store)`, a status) is awaited through `holding(promise, what, store)`, never bare: the supervisor’s restart timer is unref’d too, so the loop empties between the catch-up’s backoff and the restart (tests/store-recovery.test.mjs on CI, run 41106275069; tests/process/store-kill-fixture.test.mjs reproduces it).
- A unit test that opens a store on a data folder (`new Store(dir).load()`) starts that folder’s Redis child, as Postbox does, so the whole suite runs on the store Postbox has. `tests/guard.mjs` allows exactly that: spawning the `redis-server` of `POSTBOX_REDIS_HOME`, and connecting to the Unix socket one of those children was given in its config. Nothing else: not 127.0.0.1, nor any other port or socket. A store with no data folder (`new Store(null)`) stays in memory.
- Postbox’s Redis user may run only the commands the store sends (`STORE_COMMANDS` in server/redis-private.mjs; #508’s requirements, SR-3). A spec that needs more, to set up a failure (`CONFIG SET maxmemory`), read stats (`INFO`), count a stream (`XLEN`) or drop a connection (`CLIENT KILL`), uses `admin(store)` from `tests/redis-fixture-user.mjs`, a `fixture` user that exists only in children started after a test imported that module. Never add a command to `STORE_COMMANDS` for a test.

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
- Show a new spec failing on the code without its fix. CI runs a spec a pull request adds or edits ten times, with the events late. A later push repeats only the specs it changed or brought in, where the job passed on the push before; where it failed, was canceled or skipped, every one again (`tools/repeat-specs.mjs`).

## UAT docs

- Each UI change gets a doc under `tests/uat/`: why the component exists, what it should do, steps to reproduce, and what passes. Update the docs your change affects. Don’t refresh their screenshots (`tests/uat/screenshots/`, the one set that’s committed); the reviewing session does that (designs/prompts/README.md, “Rules for every session”). The demo’s screenshots aren’t committed: see designs/developing.md, “Screenshots”.
- The end-to-end scenarios live in `tests/uat/e2e/scenarios/`. A targeted scenario names the triggers each phase must cause (`tests/uat/e2e/README.md`).
