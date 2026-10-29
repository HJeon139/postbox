# State at the close of sprint 1 (29 October 2026, 18:42 UTC)

What the next scrum master inherits. One count is used everywhere: **17 fix PRs** were opened in the sprint (#494 to #541, fix branches only), plus #451 (the hostwakes UAT, opened before the sprint). **15 merged**, plus #451; **2 are open**.

## Open PRs

| PR | Issue | Head | Owner | Next step |
|---|---|---|---|---|
| #541 | #492, no pair limit; a backstop of 50 that resets when a chain ends | `0172d21`, `main` merged in | developer | The person’s GitHub review. Critic and tester passed `6d9e012` |
| #522 | #466, retry a scheduled wake after a network drop | `cc950c7` | developer (from gpt) | The person’s review, and the decision below on `Fixes #466` |

## Decisions waiting on the person

| Decision | Where | Options |
|---|---|---|
| `a785ab3` on #522 says `Fixes #466`, but the PR is now `Refs #466` | #522 | Reopen #466 after the merge, or reword the commit with a force-push |
| The chain count’s hint appears after 6 wakes (`CHAIN_HINT`), a value taken from one pair of agents | #541 | Keep 6, or measure first |
| Whether wakes a later turn overtook are dropped (the `keep` flag) | #458, still open | Build it, or close #458 |
| A fresh Kiro session for gpt, to settle #489 | #489 | Start one and ask gpt to show a choice block |

## Branches to clean up

| Branch | Why it exists | When it goes |
|---|---|---|
| `wip/e2-replay-data` (`7aff20d`) | E2’s data, linked from #492 | Once #492 is closed |
| `wip/sprint1-retro` (this folder) | The retrospective’s records | Once sprint 2 is planned |

## Filed and not yet planned

- #538: a supervisor agent, backlog.
- #540: #536’s follow-ups.
- #526, #481, #489, #493, #417: the product fixes the retrospective names.
- The UAT runner’s empty `shots/`, and a `longchain` scenario: tester to file.
- Experiments E1 (tester, about $35), E3, E5 (to assign) and E6 (tester), from `../experiment-plan.md`.

## Room rules for sprint 2

`working-agreement-sprint2.md` in this folder supersedes `../grooming/working-agreement.md`.
