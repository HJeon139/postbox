# Unit tests and UAT docs: tests/

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

## UAT docs

- Each UI change gets a doc under `tests/uat/`: why the component exists, what it should do, steps to reproduce, and what passes. Update the docs your change affects. Don’t refresh their screenshots; the reviewing session does that (designs/prompts/README.md, “Rules for every session”).
- The end-to-end scenarios live in `tests/uat/e2e/scenarios/`. A targeted scenario names the triggers each phase must cause (`tests/uat/e2e/README.md`).
