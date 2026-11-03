# Prompt: continue the #508 plan in a new room

Paste the section below as the first message of the next #508 room, addressed to the scrum master. It is written for the agents' first turn: everything it names is on GitHub, so no agent needs the old room.

---

@researcher, you are the scrum master for the next sprint of #508 (delivery records and a windowed transcript, https://github.com/HJeon139/postbox/issues/508). The last room closed on 3 November 2026. Continue its plan; don't restart it.

## Read first, in this order

1. `experiments/sprint2-retro/state-at-close.md` on the branch `wip/sprint2-retro`: open PRs, the work carried over, decisions waiting on me, branches to clean up.
2. `experiments/sprint2-retro/action-items.md` on the same branch: the twelve actions I approved from the retrospective. They are this sprint's rules, each with an owner and a measure.
3. `designs/508/execution-plan.md`, "Where it stands" (#710): the decisions made last sprint, including client-side virtualization before the server window.
4. `designs/508/room-rules.md` (rules 1 to 21) and `designs/review-guide.md` (#659).
5. The closing summaries on #508 (the room's close, and the retrospective).

Check each PR's head and labels with `gh` before you report it. A status claim comes from `gh` or `ls-remote`, never from what a message said.

## Before anyone gets an item (actions 5 and 6)

- **Harness and quota check.** For each agent: its backend and model as its session reports them, that it can show a block and use Postbox's tools, that it can run background commands, and that its quota will last the sprint. One harness per role for the whole sprint. Record it as a table and show it to me.
- **Shared files.** Name one owner and a landing order for `shared/state.mjs`, `server/live-streams.mjs`, `server/mcp.mjs`, `server/tool-gate.mjs` and `tests/store-held-guard.test.mjs` in the plan (action 7).
- **No local-only work.** Every branch lives in a GitHub-backed worktree from its first commit, and an approved design is pushed the turn it's approved.

## How the room runs

- **One topic thread per PR** once #639 merges (rule 20, action 2). Open it with the ask, the head and the reviewers. Asks, hand-backs and sign-offs go there; @mention only who must act next; no wake messages for coordination.
- **Hand-backs** follow rule 19: `#PR @head:` then done (with CI's pass, fail and skip counts), blocked (naming any confirm waiting on me), or not mine.
- **Design before code** for anything concurrent, durable, security-relevant or user-visible (rule 13), read by critic and one peer. Every note says what each decision reads after a restart, a reload or a turn that doesn't move on; a stopgap carries `main`'s behaviour as a table (action 4).
- **critic's adversarial pass runs in a fresh subagent** on each head handed back for review, for store, delivery, needs, security and remote code; docs-only PRs get an in-session read. Authors read the review guide; they don't run their own subagent pass (action 3).
- **The author's UAT run** for changes that touch a conversation surface, within the spending limit.
- **I approve pushes, not texts.** A confirm carries the commands, its texts and their hashes, built before it's shown and not edited while it's open (action 12). A rebase with no code change keeps its sign-off; rebase onto `main` before review, not after.
- **Status reports** update the `status-508` app, colour-coded, with the whole plan to the end state. No quizzes or exercises.

## The work, in order

1. **Measure first** (action 1): run #578's stall benchmark on a large room, and show me the numbers before any B-step or #305 slice. They decide between client-side virtualization (#712) and the server window (B1a, B2, B3).
2. **Land the open PRs.** #633 first (engineer; critic's `keptTurnId` finding is posted on the PR), then #688 and #689 (their owner answers the integrator), and anything else `state-at-close.md` lists that hasn't merged.
3. **A1b** (#711, gpt): the design first, after #633. It confirms draft 6's amendment in `designs/508/delivery-routes.md` (#708) and the integrator's six correctness findings from #608. Then A2 (#527), A3 (#528), A4 (#529).
4. **B1b** on `feat/508-b1b-view-state` (#531, engineer), then **virtualization** (#712) if the measurement says so.
5. **#305** stays parked until the integrator answers the slice-order question on #615.
6. **Small items:** #713 (the flaky epoch test), and actions 8 (fixture privacy in CI), 5 (commit author and trailer in `lint-commits`) and 11 (`lint:project` in the commit hook).

## Decisions only I make

#544 (P0 Kiro), #538 (a supervisor agent), #564 (split and priority), and which agents and harnesses join the room. Bring each as a choice block with the options and their costs.

## Your first reply

Within your first turn: the harness and quota table for the agents I've added, the open PRs as `gh` reports them now, the measurement plan for step 1 with its owner, and anything in `state-at-close.md` that has changed since it was written. Then start step 1.
