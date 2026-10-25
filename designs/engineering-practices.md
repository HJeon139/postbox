# Engineering practices

What good code looks like in Postbox, what to avoid, and what enforces each rule. It covers the tools Postbox is built with: Node, Biome (in place of ESLint), TypeScript, axe, and Kokoro. It also covers Anthropic’s guidance for building on Claude Code and the Agent SDK, and Postbox’s own rules. The antipatterns come from this repo’s own bug history, with the issue that taught each one.

Every change is checked against this page before review. `npm run check` enforces what a tool can, and the rest is the reviewer’s job.

## The gate

```bash
npm run check
```

It runs, in order:
1. `lint`: Biome, with warnings as errors.
2. `typecheck`: TypeScript over the JSDoc types, with `checkJs`.
3. `lint:project`: Postbox’s own lints for design tokens, DOM safety and copy.
4. `check:contrast`: every color pair in both themes.
5. `test`: `node:test`, with the network and process spawning blocked.

**At review,** the reviewing session runs these over the merged UI of each wave:
- `node tools/shoot-app.mjs`: it plays the demo, takes screenshots and runs axe on every scene. It must end with “Accessibility (axe-core): no violations.”
- `node tools/shoot-uat.mjs`: it refreshes the UAT doc screenshots.
- The end-to-end UAT ([tests/uat/e2e](../tests/uat/e2e/README.md)), which runs real agents and costs real usage.

The browser half of the gate:

```bash
npm run check:browser
```

It runs every headless Chrome check (`tools/check-*.mjs` and `tools/checks/*.mjs`, found by name) in parallel, 4 at a time. Each check gets its own free ports and a timeout that kills it and its Chrome. The run prints each check’s counts, time and first failure, and keeps each full log. CI runs it on every pull request. `node tools/check-all.mjs shell header` runs only the checks whose name has one of those in it. `--lag 300` holds each server’s events back 300 ms, as a busy runner can: a check that passes with it waits for the page to hear a change, not for a fixed time.

A change that’s visible in the UI also gets a browser spec from whoever writes it: Playwright Test, in `tests/browser/*.spec.mjs` (architecture.md, “Browser checks on Playwright Test”, #303). Each spec file starts its own Postbox with `startPostbox()` from `tests/browser/postbox.mjs` and calls `failOnPageErrors(test)`. It waits with web-first assertions or `expect.poll`, never for a fixed time: Biome’s `no-fixed-waits` rule fails `npm run check` on `page.waitForTimeout` or `setTimeout` in a spec.

```bash
npx playwright test                               # every spec
POSTBOX_STREAM_LAG=300 npx playwright test         # with the server’s events late, as CI’s second pass
npx playwright test needs-nav --repeat-each=10     # a spec ten times, as CI runs a new or changed one
```

The checks not yet moved stay in `tools/check-*.mjs` and `tools/checks/*.mjs`. They report through `tools/harness.mjs`, with `ports()` for `PB_PORT` and `PB_CHROME_PORT`, `record()` for each case, and `finish()` at the end, so the run reads their results, not their text.

## Node

**Do**
- Use ES modules (`.mjs`), and import built-ins with the `node:` prefix.
- Keep runtime dependencies at zero. Anything heavy is an `optionalDependency` that Postbox works without (the Agent SDK, `kokoro-js`), loaded with a dynamic `import()` inside `try`.
- Spawn processes with an argument array, never through a shell. Handle the child’s `error` event, and give long work an `AbortSignal` or a kill path. Stop is SIGINT, then SIGKILL.
- Call `unref()` on timers that shouldn’t keep the process alive. A test suite that waits on a 10-second timer has a bug.
- Write files atomically: write a temporary file, then `rename`. Never overwrite a file the person owns that you couldn’t parse.
- Bound everything an agent or app sends: strings are sliced, arrays capped, and numbers clamped, at the boundary where they enter.
- Persist state that has to survive a reload or a restart. Re-arm timers from stored state at startup.

**Don’t**
- Don’t keep state that must survive in module memory. A message typed offline was lost on reload (#18), and pending deletions were never finished after a restart (#24).
- Don’t swallow an error’s reason. A failed turn that says only “hit an error” can’t be fixed by anyone (#61).
- Don’t make a timeout promise that fires after the race is won. An unhandled rejection crashed long runs (`tools/cdp.mjs`, fixed in d11c333).
- Don’t talk to a server you didn’t start. Check that the port is free, and fail fast if the child exits. The UAT once talked to another tool’s server.

**Enforced by:**
- `tests/guard.mjs`, which blocks the network and process spawning in tests.
- Code review, for the rest.

## Biome (in place of ESLint)

Biome’s recommended preset covers ESLint’s core recommended rules and the common plugin rules, such as unused variables, `noUselessTernary` and complexity. It also formats the code. Postbox doesn’t add ESLint: two linters would disagree.

**Do**
- Run `npm run format` before committing. Formatting is never a review comment.
- When a Biome rule is turned off, do it in `biome.json`, project-wide, with the reason in the commit.

**Don’t**
- Don’t silence a rule inline with `biome-ignore` unless the line says why.
- Don’t disable a rule to make a change pass.

**Enforced by:** `npm run lint`, with warnings as errors, and CI.

## TypeScript (types in JSDoc)

Postbox is JavaScript, typed with JSDoc and checked by `tsc` with `checkJs` and `strictNullChecks` (`jsconfig.json`).

**Do**
- Type exported functions and their options objects with JSDoc, especially at module boundaries (adapters, the runtime, `shared/`).
- Narrow values from agents and apps with checks (`typeof`, `Array.isArray`, `Object.hasOwn`) before using them.

**Don’t**
- Don’t cast to `any` to make an error go away. If a boundary needs it, cast once, with a comment.
- Don’t use `in` to look a key up in a lookup table: it matches inherited names. A block of type `constructor` crashed validation (#39); use `Object.hasOwn`.

**Enforced by:** `npm run typecheck`.

## Building on Claude Code and the Agent SDK (Anthropic)

Postbox runs real agents through the `claude` CLI and the Claude Agent SDK. These rules follow Anthropic’s documentation for both: settings, permissions, headless mode, MCP, and subagents. They also follow its guidance on prompts and tool descriptions.

**Do**
- **Never handle credentials.** Agents use the person’s own Claude Code sign-in. Postbox never reads, stores or passes an API key or token.
- **Pass everything that shapes a turn explicitly:** the permission mode, model, setting sources, allowed tools and MCP config. Anything left out is taken from the person’s own settings. Their output style once steered every agent turn (#57), and their artifact tool published work outside Postbox.
- **Treat everything an agent or app sends as data:** text in, text out, never markup or commands. Validate it against the catalog at the MCP boundary.
- **Record before you guess.** Stream shapes come from real turns, saved as test fixtures (`POSTBOX_CLAUDE_RECORD`) and read in the SDK’s shipped type definitions (`sdk.d.ts`). Don’t write code against a field you haven’t seen.
- **Surface what the harness decides.** Permission prompts, refusals (`permission_denied`, `result.permission_denials`), compaction, subagent tasks and errors all reach the person (#65, #68).
- **Write the agent guide like any good prompt:**
  - Say what to do, and when.
  - Give one example per pattern.
  - Map what a reply contains to a block (“questions → a form”), not what the person asked for to a block (#63).
  - Keep it stable across turns.
- **Keep the guide and the code in agreement.** Every limit and convention the server enforces, such as event size and chart palettes, appears in the guide, the MCP tool descriptions and the kit (#50, #52).
- **Use tool descriptions to teach.** A tool’s description says what it’s for, its limits, and what it returns.

**Don’t**
- Don’t rely on the agent to follow a rule the code could enforce.
- Don’t parse model text for control flow when a tool call or structured output can carry it.
- Don’t let an agent write in the person’s voice. Postbox composes those lines (#38, #51).

**Enforced by:**
- `tests/claude-code.test.mjs`, which replays recorded streams and checks the arguments.
- The UAT’s `settings-leak`, `refusal-without-card` and `prose-instead-of-block` checks.

## The DOM, and agent content

**Do**
- Build the DOM with `h()` (`app/js/dom.mjs`). Agent and app text goes in as text nodes.
- Set HTML only from `renderMarkdown()` output wrapped in `trusted()`. `h()` ignores any other `html`.
- Keep agent apps in the CSP-sandboxed frame, reachable only through the bridge, which answers frames with origin `'null'`.

**Don’t**
- Don’t pass agent data where `h()` takes props. A plain object there became `innerHTML` (#30).
- Don’t trust an id across conversations. Check who owns it (#31).

**Enforced by:**
- `npm run lint:project` (`lint-dom`), which flags `innerHTML` and attributes built from data.
- The UAT’s sandbox checks.

## Accessibility (axe)

The target is WCAG 2.1 AA, with zero axe violations in every demo scene.

**Do**
- Make every control reachable and usable by keyboard. Return focus to where it came from when a dialog or menu closes, and keep it on the control you used when a block re-renders (#26, #33).
- Keep everything visible without hover. Hover is only for patterns made for it (hover cards), and they open by keyboard too.
- Give icon buttons an `aria-label`, groups a role and a label, and live regions only where updates matter.
- Respect `prefers-reduced-motion`. Never carry state by color alone.
- Use the design tokens for every color. `tools/contrast.mjs` checks every pair in both themes.

**Don’t**
- Don’t build a control that only appears on hover.
- Don’t use `aria-pressed` on radios, an unlabeled field, or a scroll container you can’t reach by keyboard. axe caught all three.

**Enforced by:**
- axe in `tools/shoot-app.mjs`.
- `npm run check:contrast`.
- `lint-tokens`, which flags raw colors.
- The UAT’s keyboard and focus steps.

## Narration (Kokoro)

**Do**
- Run Kokoro (`kokoro-js`) only in its own child process. It starts on first use and stops after five idle minutes. It brings native packages with open advisories (`sharp`, `onnxruntime-node`), which must never load into the server.
- Keep it optional. Without it, the player says narration isn’t installed, and the transcript still reads.
- Download the voice model to the data folder on first use, never into the repo, and never during tests.
- Cache audio by the SHA-256 of the text and voice, so the same passage is synthesized once.
- Synthesize on Play, passage by passage, so the pre-display check makes no audio.

**Don’t**
- Don’t import `kokoro-js` from server code.
- Don’t let tests or the UAT depend on audio.

**Enforced by:**
- `tests/narration.test.mjs`, with a fake worker.
- Code review.

## Tests

**Do**
- Keep `node:test` deterministic and fast (the suite runs in about a second). No network, no processes, no real time: inject `now`, and use `unref()` on timers.
- Build fixtures from recorded reality: real Claude Code streams, with local paths removed.
- Fix a bug with a test that fails without the fix. For browser behavior, a headless Chrome check (`tools/cdp.mjs`) counts. Show it failing on the old code when you can.
- Give each UI change a UAT doc under `tests/uat/` with a screenshot, why it exists, what it should do, and steps to reproduce.
- When the UAT finds a defect class a check can catch, add the check to `tools/uat/checks.mjs`.

**Don’t**
- Don’t read the person’s home folder or real config in tests. Inject it.
- Don’t sleep in a test to wait for something you could await.

## Words, diagrams and commits

**Do**
- Write all user-facing text and docs in plain American English, with curly quotes and sentence case. `lint-copy` checks spelling and quotes.
- Draw diagrams in Mermaid, never ASCII art.
- Write commit messages as [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): `type(scope): what changed`, then a body that says why, and the issue (`Fixes #NN`, one per line, so each closes). Add the co-author line when an agent wrote the change. See “Commits and versions” below.
- Make one commit per fix, so each can be reviewed and reverted on its own.

**Don’t**
- Don’t push to `main` without the gate passing.
- Don’t commit `data/`, `uat-runs/` or anything with a secret.

## Commits and versions

Postbox follows [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) and [semantic versioning](https://semver.org/), so a version says what changed since the last one, and the changelog writes itself.

**A commit message:**
- `feat(scope): …` for a feature: the minor version goes up.
- `fix(scope): …` (or `perf`) for a bug fix: the patch version goes up.
- `type!: …`, or a `BREAKING CHANGE:` footer, for a change that isn’t backward compatible: the major version goes up, even before 1.0.0.
- `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style` and `revert` don’t change the version on their own.
- The scope is optional, and names the area (`rail`, `blocks`, `adapters`, `uat`). The subject is lowercase, says what changed for the person, and the whole header fits in 100 characters.

**Enforced:**
- `tools/lint-commits.mjs` checks a pull request’s commits in CI, from v0.2.0 on.
- `npm run hooks` turns on `.githooks/commit-msg`, which checks each message as you commit.
- Merge commits, `chore(release)` commits and git’s own `Revert "…"` pass.

**A release after each merge to main:**
- CI releases it: [`.github/workflows/release.yml`](../.github/workflows/release.yml) runs on every push to main. It runs `npm run release`, which finds the commits since the last tag, takes the largest bump among them, and writes the version to package.json and package-lock.json. That adds a CHANGELOG.md section, commits `chore(release): vX.Y.Z` and tags `vX.Y.Z`. The workflow then pushes the commit and the tag to main together.
- It pushes with the workflow’s own token (`contents: write`). The `protect-main` ruleset only keeps main from being deleted, so no other credential is needed. A push made with that token starts no other workflow, so check.yml doesn’t run again on a release commit, which changes only the version and the changelog.
- A merge that moves no version (`docs`, `ci`, `test` and the rest) releases nothing. The run ends by checking that every change on main is released (`tools/release.mjs --check`).
- By hand, if the workflow can’t run: run `npm run release` on main’s tip and push with `git push --atomic origin HEAD:main vX.Y.Z`.
- The sidebar shows the build under Personas, as `vX.Y.Z · commit`, so a screenshot says which build it came from.
