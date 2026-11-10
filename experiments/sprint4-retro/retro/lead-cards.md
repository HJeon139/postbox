# Blind retrospective, sprint 4

## 1. Room setup

- The card-lifecycle ownership was coherent: PR #633 fixed the app-card fallback, PR #760 fixed expired permission cards, and PR #776 fixed declined add-agent cards. Keeping those neighboring states under one lead made the raised/expired/declined rules comparable instead of three isolated fixes.
- Security review helped before implementation grew further: `sprint4/grant-once-security-criteria-r1.md` forced the #852 design to name its key, decision point, fail-closed behavior and host boundary; `sprint4/grant-once-packet-r1.md` records the resulting answers.
- The backend outage stopped useful work across the room: message `it_CAQATN0j` paused every agent after repeated Claude Code 403s and two Postbox memory failures. Switching this lead to Codex let the close run, but the room descriptions still named the old backend.

## 2. Backlog grooming, estimation and planning

- Planning the lifecycle fixes as an ordered cluster worked: #633 landed before #760 and #776, so the later fixes built on one needs rule instead of duplicating it. The merge dates and heads are recorded by PRs #633, #760 and #776.
- #852 was too large for one sprint item. Branch `feat/852-s1-part-judge` reached `9b7d14f1` with 38 commits beyond current `main`, and `feat/852-grant-once` added two more commits at `ff48eee5`, but neither became a PR before issue #852 closed.
- Small, evidenced follow-ups were easier to finish: `sprint4/outbox-gave-up-issue-r1.md` turned #1137’s explicit “Not done” into #1193, then PR #1195 reached `cd56d304` with critic’s snapshot green and ready for integration.

## 3. Execution

- The core card fixes flowed through validation and integration: PR #633 merged at `05e5e3e1`, PR #760 at `b7a8038d`, and PR #776 at `85cd3045`; issues #366, #721 and #693 are closed.
- Review-highlight work waited and forked: critic checked PR #1159 at `6d7d253a`, the remote later moved to `3ee59255`, and the local branch has a different unpushed test commit `3b13d0a2`. The current head therefore lacks the close snapshot’s CI and review evidence.
- The outbox follow-up is split cleanly but adds integration order: PR #1195 at `cd56d304` is green and ready for the person’s merge, while PR #1212 at `fd13a180` is green and clean but still needs review and is based on #1195.
- Seven detached worktrees are clean, including the historical #693, #721 and #780 trees; their clean `git status` results mean no uncommitted product change is hidden there.

## 4. Postbox itself

- The product’s needs signal did not have one lifecycle rule at sprint start: #366 lost an older app need, #721 left an expired permission need, and #693 kept held mentions after decline. PRs #633, #760 and #776 are direct evidence of the three distinct failures.
- A failed turn could itself become a permanent need: issue #883 required PR #896 so the person could dismiss a failed reply without retrying it.
- The review UI did work proportional to all prior reviews: issue #1151 and PR #1159 measure and address the highlight rebuild, but the moving head prevented a single verified close state.
- The composer could claim it was waiting for a connection while the stream was open: issue #1193 and `sprint4/outbox-gave-up-issue-r1.md` show the mismatch; PRs #1195 and #1212 cover continued retries and reconnect behavior.

## 5. For the next sprint

- **First, cap work in progress at one reviewable head per cluster.** Evidence: #1159 has remote `3ee59255` and local `3b13d0a2`, while #1195 and stacked #1212 are both open; reconcile or merge one before opening another.
- **Second, split security-sensitive work before implementation exceeds one review.** Evidence: the unpublished #852 stack is 40 commits across `feat/852-s1-part-judge` and `feat/852-grant-once`, despite issue #852 already being closed.
- **Third, put the lifecycle matrix into one shared test boundary.** Evidence: #633, #760 and #776 each repaired a different transition—newer need, expiry and decline—so one raised/expired/declined/dismissed matrix should guard needs and held mentions together.
