# The #508 sprint retrospective: what the team said (revision 1)

Six blind answers to `PROMPT.md`, each posted as a sha256 before anyone read the others, and each hash checked against its file: researcher `828b497d`, gpt `6d9a86c8`, critic `2b18950c`, engineer `d05278b5`, developer `745d859f`, gemini `b25bb205`. Only gpt and gemini ran on another harness for part of the sprint; the others answered question 4 from what reached them.

## Themes, by how many raised them

| # | Theme | Raised by | Count |
|---|---|---|---|
| 1 | Defects reached the integrator because tests and reads followed the author's framing; critic's fresh-subagent pass fixed it | all six | 6 |
| 2 | One room, no threads: messages crossed and status claims went stale | all six | 6 |
| 3 | Each push carried too much ceremony | researcher, developer, engineer, gpt, gemini, critic | 6 |
| 4 | Rule-13 design reads paid off, but missed the class question (restart state, “equal to `main`”) | critic, developer, engineer, gpt, researcher | 5 |
| 5 | Hash-checked confirms stopped every stale write | critic, developer, engineer, gpt, gemini | 5 |
| 6 | Harnesses differed in ways nobody checked at the start | researcher, gpt, critic, engineer, gemini | 5 |
| 7 | Private data reached a public branch; it needs a check in the gate | researcher, critic, developer, gemini | 4 |
| 8 | Context and quota went on reloading one long room | researcher, engineer, gpt, gemini | 4 |
| 9 | Postbox's blocks: answered blocks refuse comments and updates, confirms are too short for their texts | critic, developer, engineer, gpt | 4 |
| 10 | The design was bigger than the measured problem | researcher, critic, gpt, engineer | 4 |
| 11 | Shared files had no owner or merge order | developer, gpt, engineer | 3 |
| 12 | Rules changed mid-sprint | critic, developer, gemini | 3 |
| 13 | Work left only on local disk | gpt, gemini, researcher | 3 |
| 14 | UAT lapsed | researcher, developer | 2 |

### 1. Defects reached the integrator: reads followed the author (6)
- **Authors tested the case they fixed, not its neighbours:** #639's lost message beside the one-mention spec, and a double post on Allow brought in by the first fix (developer); #629's reply after `close()`, #633's failed turn then an app card (engineer); #625's four bypasses and #630's second type list in `keepEvent` (gpt).
- **Readers anchored on the author's framing:** critic chose mutants from the owner's specs and missed #629, #630, #632 and #633's integrator findings (critic, integrator reviews 6571933463, 6571995357, 6571996433, 6571944328); critic signed `41cd2e2c` past a silent queued call (developer).
- **The fresh subagent changed the hit rate at once:** blockers on #631, #633 (Retry flash, three restart cases) and #639 (summary-turn bypass) before the integrator saw them (critic, developer, engineer, gpt, gemini, researcher).
- **Failing-first came from the owner's log, not a rerun,** until critic adopted the integrator's guide (gpt; #659).

### 2. One room, no threads (6)
- Hand-offs crossed: "our messages crossed again" at `41cd2e2c` and `fc8c568e` (developer); critic twice reported #629 and #633 pushed before their confirms ran (critic, engineer); researcher checked `ls-remote` before engineer's turn ended (engineer).
- Rule 6 kept every review in one room until #637 (#639) landed at the close (critic, developer, engineer, gpt, researcher); queued messages arrived in bursts with superseded asks (gemini; #595).
- Coordination went through researcher's wake messages until the person stopped it on 2 Nov (researcher).

### 3. Ceremony per push (6)
- A round was code, critic's read, the person's text approval, a push confirm, CI (20 to 40 min), a label confirm; hours of wall time for 10 to 50 lines (developer, engineer, gpt, researcher).
- A lint rule landing on `main` (#638) reopened approvals on #629 and #630 (engineer, gpt, researcher).
- #631's privacy fix took six serial hand-offs (gemini). Critic was the one reader, with five reads queued at once (gpt).
- The person's `reset-508-1` (approve pushes only; a no-code rebase keeps its sign-off) removed one step (engineer, gpt).

### 4. Rule-13 design reads (5)
- **Paid off:** #609 through four revisions, then #632's reducer change drew no integrator finding (critic); #637's three revisions moved the gate into `closedTo` and added `store.pending.thread` (developer); `design-633-turn-1` and `design-b1-2` each changed before code (engineer, gpt).
- **Missed the class:** #633 took six rounds of restart cases; a row saying "every `needs` decision reads only the store, and a restart never drops a need `main` keeps" would have named it on day one (engineer, critic). A stopgap should carry `main`'s behaviour as a table (engineer).
- **Design notes cited code that later moved** (#639's blocker 2) (developer).

### 5. Hash-checked confirms (5)
- Each push re-checked the head, the base, the remote and the texts' hashes, and stopped stale writes: #630's first confirm, `pr629-push-2` after #638 (critic, engineer, gpt, developer); force-pushes with lease on #631 (gemini).

### 6. Harnesses (5)
- **Codex ran nine days without its instructions** while tests passed (#584) (researcher).
- **Antigravity's first spike fixtures were authored, not captured** (#631, first round), and its hand-backs linked `file:///` paths that resolve only on this computer and reported a narrower lint than `npm run check` (researcher, critic, engineer).
- **Commit identity drifted:** gpt's seven delivery-routes commits carried the person's name and no trailer; `lint-commits` checks only the header (gpt).
- **A session ran on another model** for a turn and produced work the person rejected (researcher). A session ending killed a background review with no record (critic).
- **One harness per role for a sprint,** so a mid-sprint switch doesn't change who can run background commands or subagents (engineer, gpt).

### 7. Private data (4)
- #586's `installationId`, then #631's home and temp paths and account fields; hashes were checked four times, content never (researcher, critic, developer, gemini).
- The first privacy test matched only the slash form of the temp path; the fresh subagent found the dash form (critic, developer, gemini).

### 8. Context and quota (4)
- Every wake reloaded a room carrying every PR; sessions were compacted and resumed from summaries; SHAs survived because they were in files, not chat (engineer, gpt, gemini, researcher).
- Background `gh pr checks --watch` and delegated sweeps saved turns; each fresh-subagent pass costs 75k to 125k tokens, worth it for store, delivery and needs code, not docs (engineer, critic).

### 9. Postbox's blocks (4)
- An answered block refuses comments and updates, so reads went into prose and B1's design moved to a second block (critic, engineer, gpt). A confirm's 2,000-character statement can't hold its texts, so confirm and texts drift apart (developer, gpt). A progress block stalls while a background job runs (developer).

### 10. The design was bigger than the measured problem (4)
- Delivery records, attention, the log and the window were coupled, so the step that renders less waited on A1b; virtualization-first came on the last day and should have come from a measurement at the start (critic, researcher, engineer).
- #608 staged 513 lines ahead of their consumer, and an approved design lived only on a local clone (gpt).

### 11. Shared files (3)
- #630 and #632 both rewrote `shared/state.mjs` and `server/live-streams.mjs`; #639 conflicted with #689 in `server/mcp.mjs`. Seams were written in PR bodies, not the plan (developer, gpt, engineer).

### 12. Rules changed mid-sprint (3)
- The label rule changed three times (critic); the author-side sweep was asked for, then withdrawn (developer, gemini).

### 13. Local-only work (3)
- `delivery-routes.md` and the #582 settle note lived only in local clones until the closing sweep (gpt, researcher); no registry of worktrees and branch heads (gemini).

### 14. UAT lapsed (2)
- No UAT run on #629, #630, #632 or #633 (researcher); #639's UAT trigger deferred, then took twenty minutes once written (developer).

## Where the answers differ, or need checking

- **Antigravity's stability.** gemini found the harness stable for #631's edits and rewrites. The record also shows the first spike fixtures were authored rather than captured, and `file:///` links in hand-backs. Both can be true; the gap is in evidence handling, not tool calls.
- **gemini's "dropping Redis" bullet** cites `6694757c`, which is a two-line `deadline.md` fix for #582, not the Redis recall (#580). The point stands; the citation should be #580.
- **Who runs adversarial checks.** developer and engineer would run critic's pass earlier (on the design and the first red commit); gemini would keep it critic's only. The person ruled authors don't run their own.
- **How many agents.** Only researcher proposed fewer agents in flight.

## Action items proposed for the next #508 sprint

| # | Action | From themes | Owner | Measure |
|---|---|---|---|---|
| 1 | **Measure before building:** #578's benchmark on a large room before any B-step or #305 slice; the number chooses virtualization or the server window | 10 | researcher, engineer | steps started without a measured budget: 0 |
| 2 | **One topic thread per PR from day one,** after #639 merges; every ask, hand-back and sign-off in it | 2 | everyone | crossed-message turns; this sprint, many |
| 3 | **critic's fresh-subagent pass is the gate for `ready for integrator`,** run on the first code head as well as the last; its brief always covers restart state, private data in tree and history, docs against code, and `merge-tree` with open PRs | 1, 7 | critic | integrator findings per PR |
| 4 | **Rule-13 notes add two rows:** what each decision reads after a restart, reload or a turn that doesn't move on; and, for a stopgap, `main`'s behaviour as a table | 4 | authors, critic | review rounds per PR |
| 5 | **Harness check at the start:** one harness per role for the sprint, each agent's tools, background commands and quota verified before its first item; a hook checks commit author and trailer | 6, 8 | researcher, the person | mid-sprint harness switches; commits with the wrong author |
| 6 | **No local-only work:** an approved design or branch is pushed (WIP if needed) in the turn it's approved; a weekly sweep of local branches against GitHub | 13 | everyone, researcher | work found only on disk at close |
| 7 | **Shared files get an owner and a merge order in the plan,** and table-shaped refactors land first | 11 | researcher, developer | seam notes and one-line rebases |
| 8 | **The fixture privacy check runs in `npm run check`** for every recorded fixture | 7 | gemini | private data in a pushed commit: 0 |
| 9 | **Enforce a rule in the one function every path calls,** with a guard spec that every caller goes through it | 1 | authors | rules enforced in some callers only |
| 10 | **Postbox issues to file:** answered blocks accept comments and new revisions; a confirm that attaches its files and hashes them itself; a worktree and branch registry; progress steps that wait on a background job | 9, 13 | researcher files | — |

## Work carried into the next sprint

- **Changes requested, not fixed this session:** #633 (engineer; critic's `keptTurnId` finding on the PR), #688 and #689 (the asset store and tools, #516).
- **Next steps:** #711 (A1b, after #633), #712 (virtualization, after B1b on `feat/508-b1b-view-state`), #713, #305's slice order (#615).
