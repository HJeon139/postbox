# Module and function size: a ceiling that only comes down

Part of [the architecture](../architecture.md).

**Decision** (23 October 2026). Biome fails any file or function longer than its default, with `noExcessiveLinesPerFile` and `noExcessiveLinesPerFunction` as errors, over everything it checks. Each file that was already longer that day has an override in `biome.json` at the size it had, as Biome counts it: a ceiling for the file, and one for its longest function. These files can shrink but not grow, and every new file and function starts under the default.

**What it rests on**
- **The rule was written down and never enforced.** “Small enough to read in one sitting” ([front-end.md](front-end.md)) and developing.md’s one concern per module had no check behind them. `server/runtime.mjs` grew from 3,372 to 4,361 lines between v0.2.0 and v0.13.0, in under a day, and `mountComposer` in `app/js/thread.mjs` became a single function of over 800 lines. The wave prompts split files between sessions by region (“Change only the block functions”), so each session grew its region in place.
- **Biome’s defaults, not a number of our own.** Nothing in Postbox measured a better one, so the defaults stand until something does. That day, 47 of the 158 files Biome checks were over the file limit, and 120 functions in 41 files were over the function limit: 58 files have a ceiling.
- **A ceiling, not an exemption.** A `biome-ignore` turns the check off for good; an override at today’s size keeps it on. With one line added to `server/runtime.mjs`, Biome fails: “This file has too many lines (3980). Maximum allowed is 3979.”
- **The function ceiling is per file.** Biome sets options per file, not per function, so a file’s longest function sets the ceiling for all of its functions, and a shorter one could grow up to it. Review catches that, and splitting the file ends it.
- **A wrapper is a module scope, not a function.** A script that isn’t a module, such as `app/kit/kit.js`, wraps all of its code in one IIFE, so Biome counted the whole file as one 619-line function. Its override sets `skipIifes`, so its function ceiling was its longest real function’s (`legibility`, 69 lines). `legibility` then moved, with the pre-display check, to `app/kit/check.js`, whose override sets `skipIifes` too, as does `app/kit/check-layout.js`’s at the default 50. The integrator lowers `kit.js`’s ceilings to what’s left.

## What a split is for

Decided by the person, 2 November 2026. The limits exist so a reader can follow the code. Fewer lines isn’t the goal: a file holds one concern you can name in a few words, with its state and its rules, so one decision reads in one place.
- **Simplify first.** Remove a case, a flag or a duplicate before moving code. Code that got simpler often fits under its ceiling without a split.
- **Split by concern.** A new module owns one thing (“answering a read offline”, “the page’s answers from the ledger”), and its header says what. A helper split out of a long function decides one thing, and its name says what, as `shownAgain` and `blockItem` in `server/block-show.mjs` do.
- **Never compress.** Joined lines, dense one-liners, shorter names, and comments dropped to save lines make code harder to read. They fail review even when Biome passes them.
- **Never scatter.** Cutting one decision across files or helpers that only make sense together, so a reader has to jump between them to follow it, fails review too. Cutting a function at an arbitrary line to get under 50 is the same mistake.

## How a ceiling moves

- **Down:** a change that shrinks an offender lowers its ceilings to the new sizes in the same change, and removes the override once the file is under the default. No check enforces this yet, so the reviewer does.
- **Never up in the change that tripped it** (developing.md, “Lint and type-check exceptions”). A file that needs to grow is split first. A split that needs a design, as `server/runtime.mjs` does (which module owns which of its state), is decided in this document before its code moves.
- **Checked, not only reviewed** (2 November 2026). `tools/lint-caps.mjs`, in `npm run lint:project`, compares `biome.json` with its copy at the merge base with `main` (`origin/main`, or `upstream/main` when that is newer, #786) and fails closed: every difference fails unless it is known to be safe, such as a lower `maxLines`, a removed override, or a change under a key that can’t touch a length rule (the tool lists them). It also fails a nested Biome config added or changed, an added suppression that covers a length rule (`lint`, `lint/style`, `lint/complexity` or a length rule, in any `biome-ignore` form), and a run in CI with no base to compare with. A suppression in a file git ignores isn’t read, and Biome skips that file too. CI’s check job sets no base branch, so a pull request into another branch is compared with `main`. To count the files over the default, run the tool’s `ceilings()` over `biome.json`.
- **Test files too** (decided by the person, 23 October 2026). A test for code whose test file is at its ceiling goes in a new test file rather than raising the ceiling. The new file is named for the module and the concern, `tests/<module>-<concern>.test.mjs`, such as `tests/runtime-topics.test.mjs` (developing.md, “Modules”). It must end in `.test.mjs`: `npm test` runs only `tests/*.test.mjs`, so a file named anything else runs nowhere and passes.
- **A moved concern comes in under the default** (decided by the person, 2 November 2026). A new module gets no override over the default, even for code moved out of a file at its ceiling. A function the move brings past 50 lines, or a module past 300, is split in the same pull request, after the move commit: the move stays a commit of its own, so it can be checked mechanically, and only the pull request’s head has to pass the gate. The old file’s ceilings drop to its new sizes, as Biome reports them. `tools/lint-caps.mjs` fails a new override over the default.

## What a move may change

A method of a class that moves into a module becomes a function that takes the instance first: `rt` for `Runtime`, `ledger` for `Ledger`, as `askForTool(rt, …)` in `server/tool-ask.mjs` does. So:

- `this` becomes that parameter, and nothing else in a body changes.
- The class keeps a one-line method that delegates to it (`agentWake(...a) { return agentWake(this, ...a); }`), so callers and tests don’t change.
- A static becomes a module constant, and the class keeps an alias of it (`static APP_HOLD_MAX = APP_HOLD_MAX;`), so a test that reads `Runtime.APP_HOLD_MAX` doesn’t change.
- A closure that reads its enclosing function’s variables, such as a tool handler inside `toolsFor`, takes them as parameters instead. That’s the one rewrite beyond `this`, and the commit message names each parameter.
- Module-level helpers and constants the moved code reads move with it, or go to a third module both files import. They’re never imported back from the old file: that’s a circular import, which means a missing module (developing.md, “Modules”).
- The move is its own commit, with no other change. A reviewer checks it mechanically, by the recipe in developing.md, “Rules for every session”, its “Length limits”: undo the rewrite on the new module and diff it, ignoring whitespace, against the range the commit removed.
- When several sessions move code out of one file at once, only the integrator lowers that file’s ceilings, once after each merge, in a commit of its own (developing.md, “Rules for every session”, its “Length limits”). One writer means no conflicts in `biome.json`, and a ceiling left loose for a while is safe, since nothing can grow past it.
- Later changes hold the moved code to its carried ceilings, like any other.

## Which module owns which state

In `server/runtime.mjs`’s split (23 October 2026, for [#120](https://github.com/HJeon139/postbox/issues/120); [#1236](https://github.com/HJeon139/postbox/issues/1236) holds the order of moves):
- **The `Runtime` owns its state:** the store’s (`rt.s`), the turns running now (`rt.turns`) and the stops it waits on (`rt.exiting`), which are Running’s since it became a service (designs/architecture/services.md, “Running”), read through getters, the open permission cards (`rt.permissionWaits`) and its timers. A concern moved out keeps none of its own. Its functions take the runtime first, read that state through it, and change it only through the runtime’s methods (`updateSession`, `updatePersona`, `patchItem`) or the store’s events, so it can’t disagree with the runtime about a session.
- **`server/permissions-panel.mjs`** (the permissions panel, #66) is one: it reads the persona, the session, the project and the settings files’ rules (`server/permission-rules.mjs`), and writes a rule to those files, a conversation’s rules and folders to its session (`se.rules`, `se.addDirs`), and a persona’s mode with `updatePersona`. Its bounds moved with it, and so did `PERMISSION_MODES`, which the runtime imports and exports again.
- **A concern with live state of its own keeps it on one object the runtime holds,** as the remote turns do (`rt.remote`, a `RemoteTurns` from [`server/remote/turns.mjs`](../../server/remote/turns.mjs)): the remote turns running now, the stops their hosts haven’t confirmed, and the hosts Postbox needs. Its functions, in `server/remote/turns-*.mjs`, take that object first. The hosts’ own records stay in the store (`s.hosts`, `s.hostStatus`), changed by `server/remote/host-admin.mjs` and `host-status.mjs`, which keep no state.

**Revisit when** the overrides are gone, or ceilings left loose after a file shrank become common: then a test that each ceiling equals its file’s size makes the lowering automatic.
