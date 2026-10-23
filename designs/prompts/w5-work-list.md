# Prompt: wave 5, the turn’s work list (#195, #156)

A wave 5 session. The triage session integrates it, and the architectural review session reviews it. Follow [README.md](README.md) for the rules every session shares. Your ports are 4850–4899 for servers and 10150–10199 for Chrome.

---

You’re making each turn end with a list of what it did, every row leading to Work, on the branch `feat/w5-work-list`, in one pull request. The first commit makes room in `server/ledger.mjs` (README.md, “Length limits”), then one commit per issue.

## Why

- **#195:** when a turn ends, the person learns what the agent did by reading what the agent says it did. The Work line (#132) gives counts, not items. It sits above the turn’s first reply, not under its last, and many turns get none.
  - In the wave 4 manual UAT room, 20 agent turns made at least 122 tool calls, 4 apps in 11 versions and 9 blocks, but only 4 replies had a Work line.
  - In a Haiku UAT, a `sed` rename across 3 files, two commits and an app all showed as “1 command”, and Work said the turn “left nothing lasting”.
  - Commands read `$ cd "<project folder>" && …`, so at the pane’s width every row is the same path.
- **#156:** a commit made inside a compound command (`… && git add … && git commit …`) never reaches Version control, although the Files section says “Committed, not pushed”. Seen again in the UAT above, for both commits.

## Read first

- [README.md](README.md); `designs/intent.md`, Work (its rows, including the one decided on 23 October 2026: changes a command makes are seen in a git folder, not built yet); `designs/architecture.md` §14 (the work ledger) and §15 (module and function size).
- #195, with its “Decided” section: reads and fetches are one collapsed row that opens a Reads section in Work. Command changes come from comparing `git status --porcelain` and `git diff --numstat` before and after each command, read-only. #156, with its comment from 23 October.
- `server/ledger.mjs` (`toolUse`, `toolResult`, `endTurn`), `shared/work.mjs` (`summarize`, `turnLine`, `lasting`), `app/js/work.mjs` (the `at=` deep link, `mountWork`) and `workChip` in `app/js/thread.mjs`.

## The work

- **First, make room:** `server/ledger.mjs` is at its ceiling. Move its git reading into `server/ledger-git.mjs`, by the rewrite README.md’s “Length limits” allows, with their ceilings: `runGit`, `recordCommit`, `rootOf`, `tracked`, `pushed` and `gitState`. Nothing else changes in that commit. Push recording happens inside `commandEnded`, and moving it would split that method, so `commandEnded` stays where it is. Put the command snapshots in the new module.
- **#156:** when a command ends in a git folder, compare `git rev-parse HEAD` and the branch list with their values when it started. Record any new commits from `git log <before>..<after> --numstat`, as the `gitOperation` path does. Keep `gitOperation` when the stream has it, and never record a commit twice.
- **#195, the ledger:**
  - **Command changes:** snapshot `git status --porcelain` and `git diff --numstat` when a command starts and ends in a folder git tracks. Record each file that changed as a file entry under that command, with its diff from git, read-only (`GIT_OPTIONAL_LOCKS=0`, as today). When two commands overlap in one folder, name both rather than guess.
  - **Publishes:** record each app shown or updated, and each block shown, with its title, its version, and the item it’s in.
  - **Reads:** record each Read, Grep and Glob call’s path or pattern, and each WebFetch URL and WebSearch query.
  - **“Left nothing lasting”** never lists a turn that has a file, a publish, a commit or a write outside Postbox.
- **#195, the list:** see #195’s table for each row’s content, target and reason. In short:
  - It goes under the turn’s last reply, or its last block when it ends with one, once the turn ends.
  - Its heading is today’s counts line, which still opens Work at the turn.
  - Its rows go in this order: files, apps and blocks, commits and pushes, writes outside Postbox, commands, then one Reads row. Each row opens Work full screen at that item (`&full=work&at=<entry>`), and Escape returns to the same place.
  - A command row shows the agent’s description, or the command without a leading `cd <project folder> &&`.
  - After 5 rows, “N more” expands in place.
  - The list is a `ul` labeled “What this turn did”, with one link per row. At 375 px, a long path is cut in the middle and keeps its file name.
- **Work:** a Reads section, and publishes beside writes outside Postbox, each with a link to its item in the conversation. Remove the line “Changes a command makes … aren’t listed” for git folders, and say what still isn’t seen: files git ignores, and folders outside git.
- **intent.md and architecture.md:** once it’s built, change intent.md’s Work row from “to be seen (decided, not built yet)” to the present tense, and update §14’s “What it doesn’t see yet”.

## Files

- **Yours:** `server/ledger.mjs`, `server/ledger-git.mjs`, `shared/work.mjs`, `app/js/work.mjs`, `workChip` and the new list in `app/js/thread.mjs`, the ledger’s scene in `server/adapters/mock.mjs`, `tools/check-work-pane.mjs`, `tests/work.test.mjs` and new `tests/work-*.test.mjs` files, and intent.md’s Work rows.
- **Shared:**
  - **`server/runtime.mjs` and `biome.json`:** the ledger is called from `deliver` and `endWork`. If recording publishes needs more than a call or two, move what it needs out first, like the other sessions. Add `biome.json` entries only for your new modules, and leave `runtime.mjs`’s and `ledger.mjs`’s overrides to the integrator (README.md, “Length limits”).
  - **`app/js/thread.mjs`:** the side-threads session changes side-thread rendering. Change only `workChip` and the list that replaces it.
  - **`server/mcp.mjs`:** the apps session adds `retire_app`. A retired app’s row says so; coordinate on its name through the integrator.

## Done when

- Each issue has a test that fails without its fix:
  - `tests/work.test.mjs` replays a `sed` across three files, a commit with no `gitOperation`, and an app, and the turn lists all three.
  - `check-work-pane` opens each row’s target at 375 and 1280 px, with axe clean, and runs clean with `--lag 300`.
- In a manual run of the mock’s ledger scene, the list under the last reply matches Work for that turn.
- The UAT docs for Work say what changed (text only).
