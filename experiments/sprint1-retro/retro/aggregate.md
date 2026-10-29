# Sprint 1 retrospective: what the team said (revision 2)

Seven blind answers to `PROMPT.md`, each written before its author read the others: critic, developer, gpt, tester (files, sha256 checked), claude-ssh and kiro-ssh-x86 (posted in the room within the same minute, 18:03 UTC 29 Oct), and researcher (written first). Revision 2 takes in 38 comments from all six other agents (`discussion-gpt.md` and the review block’s threads). Each theme counts how many of the seven raised it in their blind answer, names who, and gives their evidence. The answers themselves are in `<handle>.md`.

## Themes, by how many raised them

| # | Theme | Raised by | Count |
|---|---|---|---|
| 1 | Wake cards held or hid hand-offs | all seven | 7 |
| 2 | A separate reviewer and tester caught real defects | critic, developer, gpt, tester, claude-ssh, kiro-ssh-x86 | 6 |
| 3 | Merges kept conflicting on the same files | researcher, critic, developer, gpt, claude-ssh | 5 |
| 4 | Roles, tools and hosts weren’t checked at the start | researcher, critic, gpt, claude-ssh, kiro-ssh-x86 | 5 |
| 5 | The integrator found what the room’s reviewers missed | critic, developer, tester, claude-ssh, kiro-ssh-x86 | 5 |
| 6 | Machine load made results unreliable | developer, gpt, tester, kiro-ssh-x86 | 4 |
| 7 | Estimation missed unplanned work | researcher, critic, gpt | 3 |
| 8 | The same news was announced several times | critic, claude-ssh, kiro-ssh-x86 | 3 |
| 9 | Worktrees and the shared git store caused mistakes | developer, tester, claude-ssh | 3 |
| 10 | Work and status changes waited with no time box or owner | tester, claude-ssh, kiro-ssh-x86 | 3 |
| 11 | A head was treated as ready before its full gate passed | developer, gpt | 2 |
| 12 | Reviews crossed with new pushes | critic | 1 |
| 13 | Decisions changed while being built | developer | 1 |
| 14 | Line ceilings and commit rules were found only at the gate | claude-ssh | 1 |
| 15 | Room rules arrived after the work began | gpt | 1 |
| 16 | Reported status didn’t match the code | gpt | 1 |

### 1. Wake cards held or hid hand-offs (7)
- One card waiting for the person refused every agent’s @-mentions, so reports and review requests reached no one until resent: researcher’s check-ins from 08:33 to 15:49 UTC on 29 Oct (researcher, tester, critic); #536’s requests (claude-ssh); #451’s and #510’s (developer); #478’s status, which got it cut from round 1 (kiro-ssh-x86).
- Issues: #439, #492, #526.

### 2. A separate reviewer and tester caught real defects (6)
- **Mutation runs found test gaps the authors’ red runs didn’t:** #485’s lost-link check, whose removal left every test passing (`2acecf0`, then the test in `451cb63`); #511’s `system` mark, which let a lost task context through (`b8c010e`); #492’s queued-wake check in `endChain`, whose removal left all 225 wake, runtime and queue tests passing (`6d9e012`). The last is a test gap: no one has shown the check isn’t redundant (tester, critic, claude-ssh).
- **Reviews found defects before merge:** #478’s joined sentences (`d5da582`); #536’s second Retry waking the same agents (`47aa466`, fixed in `a05c74b`); #522’s shutdown dropping a queued wake (`98b0707`, fixed in `cc950c7`) (critic, claude-ssh, kiro-ssh-x86).
- **Self-review found defects too:** gpt reviewing its own uncommitted #522 diff found Stop, Cancel-then-Retry and a double-recorded tool (16:16 UTC 29 Oct), which developer fixed (`1388c8b`, `fe39aa6`, `cb6dca1`) (gpt, developer).
- **Some red runs weren’t really red, and saying so mattered:** #466’s first red run left the new `server/scheduled-wakes.mjs` in place, so 3 of 6 tests weren’t run without the fix; #492’s failed on a missing `PAIR_LIMIT` import until the export was put back (tester).
- **Testing on another platform helped:** tester’s macOS runs on #495 (`841d88d`) (kiro-ssh-x86).

### 3. Merges kept conflicting on the same files (5)
- `server/adapters/claude-stream.mjs`, `server/runtime.mjs` and `designs/intent.md` row 129 conflicted again and again: #498 (`dd0d681`, `3a2035e`), #511 (`d11c762`), #512 (`2dbbf56`), #513 (`7234d68`), #536 (`b944250`, `dfee586`, `5145312`).
- CI doesn’t run on a conflicting PR, so each conflict also stalled checks (researcher).

### 4. Roles, tools and hosts weren’t checked at the start (5)
- gpt’s Kiro session had no Postbox tools all sprint, so its drafts were relayed (#489; it_MM9VLGV5) (gpt, critic, claude-ssh, researcher).
- Two Kiro agents worked as developers with reviewer or researcher instructions in their prompts (kiro-ssh-x86, critic, researcher; `kiro-x86-persona`).
- A remote agent couldn’t reach the person’s settings or another agent’s files, so every hand-off needed a pushed branch and pasted evidence (#417) (claude-ssh, kiro-ssh-x86).
- The remote host needed setup first: Node wasn’t on PATH, and its 077 umask failed a test (#490), so every gate there runs under umask 022 (claude-ssh).

### 5. The integrator found what the room’s reviewers missed (5)
- After critic’s and tester’s approval: #496’s purge crash (`f4e7e67`); #536’s `/compact` and double Retry; #513’s non-move (`cd13330`); #509’s CJK text and long tokens; #511’s slash and reattach turns; #495’s lock queue and duplicate reports, in layered rounds (kiro-ssh-x86); #500’s `skip` count (`75b2a87`); #497’s replayed host calls (`cde2543`) and message order (`54d7ad4`); #522’s three defects at the 17:45 re-review (`5c7dd30`, `0271da5`, `98b0707`) (critic, developer, tester, claude-ssh, kiro-ssh-x86).
- Seven PRs got blocking integrator points after critic’s approval: #495, #496, #509, #511, #513, #522, #536 (critic).
- critic’s diagnosis: reviews checked the change’s intended path, not the neighboring inputs (other backends, slash and attach turns, Retry and restart, non-ASCII and long tokens, the branch merged with today’s `main`).
- **The other side:** one review finding was wrong. critic’s P2 on #497 and #498 assumed every host call reached `onTool`; `TOOL_ROUTES` answers reads on the host (`broker-tools.mjs:131–136`), and it was withdrawn (critic).

### 6. Machine load made results unreliable (4)
- Gates and browser runs failed at load averages of 70–155 and passed on rerun (#493; #492’s lagged run, 17 failures at about 155, then 88 of 88) (developer, gpt, tester, kiro-ssh-x86).
- The same full lagged suite passed 432 of 432 at about 55, under the browser lock (#492 at `7c41687`), which supports reading the 155 failures as load (tester).
- `with-lock.sh` helped once everyone used it (developer, tester, gpt).

### 7. Estimation missed unplanned work (3)
- Blind cards against a scale with reference PRs worked, and their spread showed unclear scope (`poker-round2.md`, `estimates-*.json`) (critic, gpt, researcher).
- They weren’t fully blind, since each turn reads the room first (researcher).
- Estimates left out review repair, integration and merge drift: #511, #513, #536 and #522 each needed rounds after their tests passed (gpt).
- Hotfixes (#504, #492, #503, #510) had no points, so the burndown missed most of the sprint’s work (critic, researcher).

### 8. The same news was announced several times (3)
- A reply plus one `wake_agent` per recipient repeated a report up to six times (#481; it_HKypLD, it_pedTLlz, it_JfqL0RYN) (critic, claude-ssh, kiro-ssh-x86).
- A mention inside quoted text woke an agent for nothing (it_DCDW6ixC) (critic).

### 9. Worktrees and the shared git store caused mistakes (3)
- A `git stash` popped another session’s stash, and git’s conflict cache replayed a stale resolution into #498 (`3a2035e`) (developer).
- A `node_modules` link was committed (#501’s first head) (claude-ssh); a red-run worktree kept staged files (tester).

### 10. Work and status changes waited with no time box or owner (3)
- E4 was promised three times before it ran; E1, E3, E5 and E6 never ran (`experiments/plan.md`) (tester).
- #485’s reproduction ran long with no agreed fallback (claude-ssh).
- “Internally approved” sat for hours before “PR open”, waiting on PR drafting (#478 approved at `49a6b6a`, PR #509 later) (kiro-ssh-x86).

### 11. A head was treated as ready before its full gate passed (2)
- `4abd1d9` and `379d775` were pushed before their full gate, which failed (developer).
- gpt’s `d1811486` was an explicit work-in-progress hand-over, naming its open defects and that the gate hadn’t run; it failed `npm run check` when picked up (`bb16133`). The risk is treating such a head as ready for acceptance, not the hand-over itself (gpt, developer).

### 12. Reviews crossed with new pushes (1)
- Rounds were spent on “that crossed with my push”: #492 (`9d60fb9` reviewed while `7c41687` landed), #495 (`c343e3b` vs `3cfdb20`), #451 more than once (critic).

### 13. Decisions changed while being built (1)
- #492 was built three times: no pair limit, no limits, then a backstop of 50 that resets (`9d60fb9`, `7c41687`, `6d9e012`); the reset came only after the backstop was built (developer).

### 14. Line ceilings and commit rules were found only at the gate (1)
- #536 needed a refactor (`7a22845`), a test-file split (`0c1f626`), and left the Agent SDK raw tail undone (#540); a commit header over 100 characters (`6f8b557`) and four fixes in one commit (`5956c93`) (claude-ssh).

### 15. Room rules arrived after the work began (1)
- The co-author trailer rule came after branches existed, forcing history rewrites on #468/#488, #486 and #466 (gpt).

### 16. Reported status didn’t match the code (1)
- A #522 summary said Stop settled the schedule; reading `Runtime.stop()` showed it stayed `{ running: true }` (gpt).

## Where the answers differ
- **Full browser runs:** not a real disagreement; tester and kiro-ssh-x86 agree on a combined rule: targeted specs on each head, one full matrix before merge, and a full rerun only to clear a failure.
- **Drafts before every outside write:** developer keeps the rule; its cost is a review round per draft, and one gap: a head that moves after approval.
- **Check-ins:** gpt asks that check-ins report only changes in state, or a broken promise.

## Each agent’s first change for the next sprint
| Agent | Their first change |
|---|---|
| critic | Review every input class before approving: other backends, slash and attach turns, retries, non-ASCII, the branch merged with today’s `main` |
| claude-ssh | Authors and reviewers check today’s `main` merged in and the edge paths before approval |
| kiro-ssh-x86 | Integrator-level review before repeated full validation |
| developer | Settle each decision, edges included, before building it |
| researcher | A merge plan up front: shared files per item, and a merge order |
| gpt | Done means an open, mergeable PR with its review and gate evidence |
| tester | One worktree per head, and a two-way check of every moved line |

## Actions for the next sprint
1. **A review checklist with an author’s part and a reviewer’s part.** Author: merge today’s `main` and check the edge paths before asking for review. Reviewer: other backends, slash and attach turns, Retry and restart, non-ASCII and long tokens, a two-way diff of moved code, the branch merged with `main` (`git merge-tree` and the size lint); every finding cites the line read. Measure: fewer than the 7 PRs that got blocking integrator points after approval. Owner: critic. (themes 2, 5)
2. **An early integrator-level checkpoint** on each PR’s risky paths before repeated full validation, not only critic’s checklist. Owner: the person, with researcher scheduling it. (theme 5)
3. **Tester mutates each new guard** alongside the author’s red run, says when a red run isn’t truly red, and diffs moved code both ways; added to rule 9. Owner: tester. (theme 2)
4. **A merge plan before the round:** shared files per item and a merge order; merge `main` into open PRs as soon as a neighbor merges; an author says so before pushing on a head under review, and reviewers review the newest named head. Owner: researcher. (themes 3, 12)
5. **Observed start-of-room checks:** each agent actually shows a choice block and runs `npm run check` once on its host, and researcher checks its role in the session record, not its own say-so; fresh sessions after a role change; the room’s rules settled before any branch. Owner: researcher. (themes 4, 15)
6. **Settle decisions, edges included, before building:** a choice block with the alternatives and their costs, answered before the branch. Owner: researcher. (theme 13)
7. **Gates before acceptance:** a head goes to acceptance review, PR-ready or merge only after its own full gate under both locks, `node tools/lint-commits.mjs`, `npx biome check`, and a red run against the parent head. A work-in-progress hand-over is allowed if labeled as one. Owner: each author. (themes 11, 14)
8. **Status claims cite a readback or a test,** not the implementer’s summary. Owner: everyone. (theme 16)
9. **Estimate hotfixes, and give every planned item a time and owner,** including the experiments: E1 and E6 (tester), E3 and E5 (to assign), each scheduled or dropped with a reason. Owner: researcher. (themes 7, 10)
10. **Posting after approval:** a draft whose head moved may be posted with a small, stated change; anything more is shown again. Owner: everyone. (developer)
11. **Product fixes:**
    - open: #526 (cards), with an interim rule to resend a hand-off that “woke no one” as soon as its card is answered; #481 (one announcement); #489 (Kiro tools); #493 (load-sensitive tests); #417 (remote file access); the UAT runner’s empty `shots/`, and a `longchain` scenario (tester to file); polite @-mention loops bounded only by #492’s backstop of 50 until #538;
    - fixed this sprint: #484 (summaries dropped mentions; E4: 3.9%), #499 (mentions cut at 2,000 characters), #510 (an unhandled rejection stopped the server), with #439, #504, #485 and #503.
