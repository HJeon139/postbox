# State at the close of sprint 4 (10 November 2026, 18:25 UTC)

This merges the twelve close replies with GitHub. Heads and states are from `gh pr list --state open --json …`, exit 0, read at 18:25 UTC. Where critic's `pr-check.json` (about 17:40 UTC) disagrees with GitHub now, GitHub wins, and the row says so.

## The sprint in numbers

The sprint ran from when the room opened, on 6 November 2026 at 07:40 UTC.

| Measure | Value | Command, exit code |
|---|---|---|
| PRs merged | 167 | `gh pr list --state merged --limit 500 --search "merged:>=2026-11-06T07:40:59Z"`, exit 0 |
| Issues closed | 168 | `gh issue list --state closed --limit 500 --search "closed:>=2026-11-06T07:40:59Z"`, exit 0 (read at 17:40 UTC) |
| Open issues | 314 | `gh issue list --state open --limit 1000`, exit 0 (read at 17:40 UTC) |
| Open PRs | 22 | `gh pr list --state open --limit 40`, exit 0 |

The two PRs merged during the close were #1178 at 18:17 UTC and #1159 at 18:19 UTC.

## Open PRs, in merge order

### 1. Ready for the person's merge: 11 PRs

That's well above rule 17's limit of 4. Stacked pairs are marked; merge the base first.

| PR | Head | Owner | CI or merge state now | Next |
|---|---|---|---|---|
| #1203 (#1155 rev. 13) | `eb475e70` | lead-delivery | green in critic's check | Merge. Then lead-delivery opens a PR for `docs/1155-principles` |
| #1199 (#1132) | `4ddde8c0` | lead-security | green | Merge |
| #1200 (#1125) | `874b27c9` | lead-security | green | Merge **before #1201** |
| #1195 (#1193) | `cd56d304` | lead-cards | green | Merge **before #1212** |
| #1177 (#1143) | `9deaaa53` | lead-host-install | GitHub approved. Critic saw a conflict at the old head; lead-host-install saw it mergeable but blocked | Find what blocks it, then merge **before #1198** |
| #1184 (#927) | `24b1a81a` | lead-security | CI was running at critic's check | Merge once green |
| #1188 (#362) | `f4c63e2c` | lead-security | same | Merge once green; a Mac check is worth running |
| #1190 (#362) | `4fbaf5ea` | lead-security | new head since critic's check | CI on the new head, then merge |
| #1182 (#1134) | `d2d7a8ac` | lead-state | new head since critic's check (your fixes) | CI, then merge. GitHub's head already covers the fan-out case |
| #1183 (#1162) | `e64e85c9` | lead-sweep | CI was running; #1178 under it has merged | Retarget if needed, then merge |
| #1165 (#1135) | `7f3ebd93` | lead-state | **blocked**; head moved again since lead-state's reply | CI, then merge |

### 2. Labeled but not ready: 1 PR

| PR | Head | Owner | Why | Next |
|---|---|---|---|---|
| #1181 (#1150) | `25abfc9a` | lead-measure | Integrator approved, but CI failed at the old head. A new run was pending at the close (`gh pr checks 1181`, exit 8) | lead-transcript's one-line `wholeRoom(test)` fix, if CI fails again. Its merge closes #1150 |

### 3. Stacked on an unmerged base: 3 PRs

| PR | Base | Owner | Next |
|---|---|---|---|
| #1201 (#1125) | #1200 | lead-security | After #1200: retarget, gate, critic's label |
| #1212 (outbox) | #1195 | lead-cards | After #1195: review |
| #1198 (#1143) | #1177 | lead-host-install | After #1177: retarget, CI. researcher's check passed on this head |

### 4. Needs review, no label: 3 PRs

| PR | Head | Owner | Next |
|---|---|---|---|
| #1194 (#1180, breaking) | `d798d543` | lead-state | Fresh CI (the last run was cancelled), critic's full read, then merge |
| #1202 (#1196, #1197) | `c277a329` | lead-host-install | researcher's check passed on this head; review |
| #1211 (#1189 follow-up) | `e8dca5ed` | lead-sweep | tester's Chromium and Firefox runs never reported; rerun them |

### 5. Changes requested: 2 PRs

| PR | Head | Owner | Next |
|---|---|---|---|
| #1175 (#1084) | `7f443c79` | lead-host-install | Address critic's comments; then critic and researcher recheck the new head |
| #1169 (#1146) | `f5ab5bae` | lead-security | Hold only the failed agent's share; record it in `designs/intent.md`; fix the toast. A local start is kept as a WIP commit |

### 6. Drafts: 2 PRs

| PR | Head | Owner | Next |
|---|---|---|---|
| #1185 (#1166) | `4f62dbfa` | lead-transcript (lead-measure helped) | CI's “ten times” job finds no tests, since the spec needs `POSTBOX_BUDGET`. Fix that, add the element-count gate, take a clean reference sample on the final head |
| #1147 (#987) | `b31e4326` | tester | Fails as designed until lead-state's #987 fix, which isn't started. It also failed `redraw-focus.spec.mjs:129` twice; flake or real is unknown |

## Pushed branches with no PR

| Branch | Head | Owner | Next |
|---|---|---|---|
| `docs/1155-principles` | `366937a2` | lead-delivery | Rebase after #1203, gate, PR |
| `feat/305-3-read` | `a3314905` | lead-delivery | Finish the Work view and totals; sprint 5 |
| `feat/866-w5` | `4a25ad6a` | lead-transcript | Rebase, gate, PR, a Mac check with Firefox; sprint 5 |
| `fix/1161-followup` | `4567e9ab` | lead-sweep | Pushed during the close, by the person's choice; PR once the review queue allows |

## Archived during the close

By the person's choice, these five branches were tagged as `archive/<branch>` at their heads, then deleted on GitHub (`git push`, exit 0 both times):

| Branch | Head | Owner |
|---|---|---|
| `feat/508-bench-app` | `b07238eb` | lead-measure |
| `feat/508-switch-bench` | `656faf4d` | lead-measure |
| `feat/852-s1-part-judge` | `9b7d14f1` | lead-cards |
| `feat/852-grant-once` | `ff48eee5` | lead-cards |
| `docs/508-close-out` | `61c8c921` | tester |

`7c3a71ff`, the switch bench's `--needs` timing, was only on lead-measure's local `wip/switch-needs`, which was removed in the cleanup. No tag holds it.

## Decisions taken at the close

| Decision | Choice |
|---|---|
| The close sweep's 25 drafted comments | Reviewed and approved; 23 ready to post behind a confirm, #983 held for its UAT run, #508 held for its wording |
| The switch bench | Archived |
| The #852 branches and refs | Retired |
| `docs/508-close-out` | Archived |
| The generic allow list | Kept on the backlog |
| A Mac check for server changes touching paths, temp folders or OS limits | Not made a rule |
| Local cleanup of merged worktrees and branches | Approved; done by each agent, two at a time |

## Settled during the close

- **The commits pushed after the pause** to #1182, #1165, #1184, #1188 and #1190 were the person's, so no agent worked during the pause. The leads' local versions of those fixes were reset or kept only on local `wip/*` branches for comparison.
- **lead-sweep's local #1178 commit** went on `fix/1161-followup`, by the person's choice.
- **#464** closed as completed on 6 November, through #736, #755, #770 and #808. lead-host-install's two earlier “not started” replies were wrong.

## Carried into sprint 5

- The open PRs above, in that order, with the person's review capped at 4 at once.
- #987's fix (lead-state), which unblocks #1147.
- #1136 (lead-state), after #1169.
- #1075's follow-up PR for the integrator's should-fixes (lead-transcript).
- #1188's P3 and its FIFO hang; #1125's lfs item; #362 (lead-security). `wip/1184-extra-cases` holds test cases to check against #1184.
- A clean before-and-after for #1159's change (tester). #1159 merged at 18:19 UTC without one.
- #1211's Firefox run, and the #1175 and #1198 rechecks, which need fresh worktrees.
- The Linux repro sweep (lead-sweep).
- Claude Code's 403, and the reply to the operations team.
- #1210 and #1213, Postbox running out of memory.
- Five room descriptions that still say “Claude Code, Opus 5.5, high effort”.
- What the cleanup skipped: six branches with unmatched commits, nine scratch worktrees with uncommitted probes, and lead-host-install's unlisted branches and backup refs.

## Limits of this record

- **The issue counts** are from 17:40 UTC and weren't reread at the close.
- **CI** is critic's snapshot except where a row says otherwise. Several PRs have new heads, so their CI was still to run.
- **Ownership** comes from each agent's branches, since every agent shares one GitHub account.
