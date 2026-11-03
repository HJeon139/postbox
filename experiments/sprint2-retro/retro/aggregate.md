# The #508 sprint retrospective: what the team said (revision 2)

Six blind answers to `PROMPT.md`, each posted as a sha256 before anyone read the others, and each hash checked against its file: researcher `828b497d`, gpt `6d9a86c8`, critic `2b18950c`, engineer `d05278b5`, developer `745d859f`, gemini `b25bb205`. Revision 2 takes every agent's line comments on revision 1 (37 comments: engineer 6, gemini 6, critic 7, developer 9, gpt 9).

**On harnesses:** gpt and gemini ran on Codex and Antigravity for part of the sprint. The quota switch also reached Claude-side sessions: critic's and researcher's sessions reported running on a model other than the one set (critic from 2 November; researcher moved from Fable to Opus, and for one turn ran on a Gemini model).

## Themes, by how many raised them

| # | Theme | Raised by | Count |
|---|---|---|---|
| 1 | Defects reached the integrator because tests and reads followed the author's framing; critic's fresh-subagent pass began to close the gap | all six | 6 |
| 2 | One room, no threads: messages crossed, and status claims were taken from the room | all six | 6 |
| 3 | Each push carried too much ceremony | all six | 6 |
| 4 | Rule-13 design reads paid off, but missed the class question (restart state, “equal to `main`”) | critic, developer, engineer, gpt, researcher | 5 |
| 5 | Hash-checked confirms stopped each stale write we saw | critic, developer, engineer, gpt, gemini | 5 |
| 6 | Harnesses and models differed in ways nobody checked at the start | researcher, critic, gpt, engineer, gemini | 5 |
| 7 | Private data reached a public branch; it needs a check in CI, tree and history | researcher, critic, developer, gemini | 4 |
| 8 | Context and quota went on reloading one long room | researcher, engineer, gpt, gemini | 4 |
| 9 | Postbox's blocks: comments refused on answered blocks; a confirm can't carry or diff its texts | critic, developer, engineer, gpt | 4 |
| 10 | The design was bigger than the measured problem | researcher, critic, gpt, engineer | 4 |
| 11 | Shared files had no owner or merge order | developer, gpt, engineer | 3 |
| 12 | Rules changed mid-sprint | critic, developer, gemini | 3 |
| 13 | Work left only on local disk | gpt, gemini, researcher | 3 |
| 14 | UAT lapsed, by scoping, not cost | researcher, developer | 2 |

### 1. Defects reached the integrator: reads followed the author (6)
- **Authors tested the case they fixed, not its neighbours:** #639's lost message beside the one-mention spec, and a double post on Allow from the first fix (developer); #629's reply after `close()`, #633's failed turn then an app card (engineer); #625's four bypasses and #630's second type list in `keepEvent` (gpt).
- **Readers anchored on the author's framing:** critic chose mutants from the owner's specs and missed #629, #630, #632 and #633's integrator findings (critic); critic signed `41cd2e2c` past a silent queued call (developer).
- **The guide's mechanical checks caught what reads had missed:** rerunning failing-first on `main` and `merge-tree` found #630's conflict with #638 and #639's spec gap on the page path (gpt; #659).
- **The fresh subagent began to close the gap:** six blockers before the integrator on 2 and 3 November, on #631, #633 and #639 (critic, developer, engineer, gemini, researcher). The measure is still ahead: the integrator hasn't yet reviewed a head that passed it (#631 at `95e1309a`, #639 at `611c243c`) (critic).

### 2. One room, no threads (6)
- Hand-offs crossed (“our messages crossed again” at `41cd2e2c`, `fc8c568e`) (developer); rule 6 kept every review in one room until #637 (#639) at the close (critic, developer, engineer, gpt, researcher); queued messages arrived in bursts with superseded asks (gemini; #595).
- **Status claims taken from the room, not GitHub:** critic said the person had confirmed #629's push from a room echo, and wrote #633 “pushed” before its confirm ran; researcher checked `ls-remote` before engineer's turn ended (critic, engineer). The rule: a status claim comes from `gh` or `ls-remote`.
- Coordination ran through researcher's wake messages until the person stopped it on 2 Nov (researcher).

### 3. Ceremony per push (6)
- A round was code, critic's read, the person's text approval, a push confirm, CI (20 to 40 min), a label confirm: hours for 10 to 50 lines (developer, engineer, gpt, researcher). Work waited mostly on confirms and crossed messages, not CI (critic).
- **CI tests the merge with `main`,** so a rule landing on `main` (#638) turned green PRs red and reopened approvals on #629 and #630; #633 conflicted with #630 in `server/index.mjs` (engineer, gpt, researcher).
- #631's privacy fix took six serial hand-offs (gemini); critic was the one reader, with five reads queued at once (gpt).
- `reset-508-1` (approve pushes only; a no-code rebase keeps its sign-off) removed one step (engineer, gpt).

### 4. Rule-13 design reads (5)
- **Paid off:** #609 through four revisions, then #632's reducer change drew no integrator finding (critic); #637's three revisions moved the gate into `closedTo` (developer); `design-633-turn-1` and `design-b1-2` each changed before code (engineer, gpt).
- **Missed the class:** seven #633 heads were reviewed after the first sign-off, two by the integrator (`82a6c06c`, `289bf2da`) and five by critic's fresh subagent (`98f764b9`, `004f3e3d`, `75f6930e`, `4207013d`, `e776d4b0`); each subagent round found a new restart case, five of the seven the same class: a `needs` decision read from memory, or a recomputation that ignored the current need (engineer, critic). The last pass, with a full restart matrix compared cell by cell with `main`, found the remaining case in one round (engineer).
- **Design notes cited code that later moved** (#639's blocker 2) (developer).

### 5. Hash-checked confirms (5)
- Each push re-checked head, base, remote and the texts' hashes, and stopped each stale write we saw: #630's first confirm, `pr629-push-2` after #638 (gpt, critic, engineer); the remote branch and PR head checks in `run632.sh` and `run639*.sh` (developer); #631's force-pushes with lease (gemini).

### 6. Harnesses and models (5)
- **Codex ran nine days without its instructions** while tests passed (#584) (researcher).
- **Antigravity's tooling was reliable; its evidence handling wasn't:** file operations, tests and git ran without failures (gemini); the first spike fixtures were partly hand-built for edge cases but labelled “recorded” (gemini, critic, researcher), and hand-backs linked `file:///` paths that resolve only on this computer (critic, engineer, gemini). One hand-back reported a narrower lint than `npm run check` (critic).
- **Mixed backends left checks unverified:** the needsnav UAT marked `delivery-dropped` “unverified on Claude Code” for every agent (engineer).
- **Commit identity drifted:** gpt's seven delivery-routes commits carried the person's name and no trailer, in a clone the room's hooks never saw; `lint-commits` checks only the header (gpt).
- **Sessions changed model mid-sprint** (critic, researcher); one turn on another model produced work the person rejected (researcher). A session ending killed a background review with no record (critic).
- **One harness per role for a sprint,** so a switch doesn't change who can run background commands or subagents (engineer).

### 7. Private data (4)
- #586's `installationId` (critic, researcher), then #631's home and temp paths and account fields; hashes checked four times, content never (critic, researcher, developer, gemini).
- The first privacy test matched only the slash form of the temp path; the fresh subagent found the dash form; gaps remain (no-slash `claude-<uid>`, `-Users-user-` slugs, tokens, `utilization`), and CI sees the tree while #631's leak lived in earlier commits (critic, developer, gemini).

### 8. Context and quota (4)
- Every wake reloaded a room carrying every PR; sessions were compacted and resumed from summaries; SHAs survived because they were in files, not chat (engineer, gpt, gemini, researcher).
- Background `gh pr checks --watch` and delegated sweeps saved turns; a fresh-subagent pass costs 75k to 125k tokens, worth it for store, delivery, needs, security and remote code, not docs (engineer, critic, gpt).

### 9. Postbox's blocks (4)
- **Gap:** an answered block refuses comments, so reads went into prose (critic, gpt), and B1's revision moved to a second block (engineer).
- **Safeguard, keep it:** an update refused because the person had answered an older revision was correct (gpt). The gap is that a confirm doesn't show that a file it hashes changed after it was shown (gpt).
- **A confirm's 2,000-character statement can't hold its texts,** so review blocks stood in for push confirms (`push-639-r2` to `r4`): approve and push become one click, and the diff from the last approved text is prose, not computed (developer, gpt). A progress block stalls while a background job runs (developer).

### 10. The design was bigger than the measured problem (4)
- The log, records, attention and the window were coupled, so the step that renders less waited on A1b; virtualization-first came on the last day and should have come from a measurement at the start (critic, researcher, engineer).
- #608 staged 513 lines ahead of their consumer (gpt).

### 11. Shared files (3)
- #630 and #632 both rewrote `shared/state.mjs` and `server/live-streams.mjs`, each carrying the same four-item seam list; #639 conflicted with #689 in `server/mcp.mjs` (developer, gpt, engineer).

### 12. Rules changed mid-sprint (3)
- The label rule changed three times (critic); the author-side sweep was asked for, then withdrawn (developer, gemini).

### 13. Local-only work (3)
- `delivery-routes.md` and the #582 settle note lived only in local clones until the closing sweep; every agent's branches should live in GitHub-backed worktrees from the start (gpt, researcher); no registry of worktrees and branch heads (gemini).

### 14. UAT lapsed (2)
- No UAT run on #629, #630, #632 or #633 (researcher). #639's spec 8 was deferred because `delivery.md` was capped at eight phases; a new scenario, `opentopic.md`, met it with no new trigger code, three runs for $1.65. A scoping call, not cost (developer).

## Where the answers differ

- **When critic's pass runs.** developer: earlier, on the design and the first red commit. engineer: on the first code head, with a restart matrix for stopgaps. gemini: a first-head pass scoped to architecture and invariants. gpt: the last head for store, delivery, needs, security and remote code, a first-head pass optional. critic: every head handed back for review, nothing extra. All agree authors don't run their own, as you ruled. **This is yours to choose** (action 3).
- **How many agents.** Only researcher proposed fewer agents in flight.
- **Pre-commit hooks vs CI.** gemini and developer propose hooks; gpt notes a hook lives in one clone and one harness, so identity checks belong in CI. Action 5 puts identity in CI and keeps fast local lint in the hook.

## Action items proposed for the next #508 sprint

| # | Action | Themes | Owner | Measure |
|---|---|---|---|---|
| 1 | **Measure before building:** #578's benchmark on a large room before any B-step or #305 slice; the number chooses virtualization or the server window | 10 | researcher, engineer | steps started without a measured budget: 0 |
| 2 | **One topic thread per PR from day one,** after #639 merges; every ask, hand-back and sign-off in it; status claims from `gh` or `ls-remote`, never the room | 2 | everyone | corrected status claims (this sprint: at least 3) and “messages crossed” replies (this sprint: about 56 mentions in the coordinator's transcript, repeats included; a clean count at the next close) |
| 3 | **critic's fresh-subagent pass gates `ready for integrator`** for store, delivery, needs, security and remote code, on each head handed back for review; its brief always covers restart state (a full restart matrix against `main` for stopgaps), private data in tree and history, docs against code, and `merge-tree` with open PRs; docs-only PRs keep an in-session read. **When the pass runs is your choice** (see above) | 1, 7, 8 | critic | integrator findings per PR, starting with #631 and #639 |
| 4 | **Rule-13 notes add two rows:** what each decision reads after a restart, a reload or a turn that doesn't move on; and, **mandatory** for a stopgap or a “same as `main` except” PR, `main`'s behaviour as a table | 4 | authors, critic | review rounds per PR (#633: seven) |
| 5 | **Harness check at the start:** one harness per role for the sprint; each agent's tools, background commands, model and quota verified before its first item; shared texts use repo-relative or GitHub links, never `file:///`; `tools/lint-commits.mjs` in CI checks the trailer and an agent commit's author | 6, 8 | researcher, the person; gpt for the CI check | mid-sprint switches; wrong-author commits: 0 |
| 6 | **No local-only work:** branches in GitHub-backed worktrees from the start; an approved design or branch pushed (WIP if needed) in the turn it's approved; a weekly sweep of local branches against GitHub | 13 | everyone, researcher | work found only on disk at close: 0 |
| 7 | **Shared files get an owner and a merge order in the plan:** `shared/state.mjs`, `server/live-streams.mjs`, `server/mcp.mjs`, `server/tool-gate.mjs`, `tests/store-held-guard.test.mjs`; the second lander carries the seam list, written once in the plan; table-shaped refactors land first; **rebase onto `main` before review, not after** | 3, 11 | developer, researcher | seam lists duplicated in two bodies; approvals reopened by a rebase |
| 8 | **Fixture privacy:** widen `tests/fixtures-privacy.test.mjs` (no-slash `claude-<uid>`, `-Users-user-` slugs, tokens, `utilization`), have CI scan the PR's commits as well as its tree, and set at sprint start when synthetic fixtures are allowed and how they're labelled | 7 | gemini | private data in a pushed commit: 0 |
| 9 | **Enforce a rule in the one function every path calls,** with a guard spec that scans every caller goes through it and a delete-a-line mutant on its check (#639's summary rule, #632's held view, #633's `releaseNeed`) | 1 | authors | reviewer or integrator findings of a rule bypassed through another caller: 0 |
| 10 | **Postbox issues to file:** comments on answered blocks; a confirm that attaches and hashes its files, shows when one changed after it was shown, and diffs each text against its last approved revision; a worktree and branch registry; progress steps that wait on a background job; the page's reply count not opening a topic thread (two of three `opentopic` UAT runs); #485 still reproduces (run `2026-11-02T17-13-41-opentopic`) | 9, 13, 14 | researcher files | — |
| 11 | **The commit hook also runs `npm run lint:project`** (about 0.4 s) | 3 | developer | follow-up commits that only fix lint-copy: 0 |
| 12 | **Until Postbox's attached-files confirm ships,** owners build and hash every file a confirm names before showing it, and never edit those files while it's open | 5, 9 | every owner | confirms shown again because their files changed (this sprint: one) |

## Work carried into the next sprint

- **Changes requested, not fixed this session:** #633 (engineer; critic's `keptTurnId` finding on the PR), #688 and #689 (the asset store and tools, #516).
- **Next steps:** #711 (A1b, after #633), #712 (virtualization, after B1b on `feat/508-b1b-view-state`), #713, #305's slice order (#615).
