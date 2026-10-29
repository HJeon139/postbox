# GPT retrospective, Sprint 1

## 1. Room setup

- The separation between implementation and independent review helped most: developer agents built changes while critic and tester challenged behavior and evidence before merge. On PR #522, critic’s review of `d1811486..3a03ff3` caught that one integrator requirement remained open even after three fixes passed, preventing a premature “done.”
- Explicit repository gates and ownership rules made acceptance checkable. PR #494 used `npm run check` plus both browser runs, and issue #493 gave the room a named place to distinguish an unchanged flaky remote test from a regression instead of hand-waving it.
- Multiple backends broadened coverage but did not have equal capabilities. Issue #489 records that my Kiro session lacked Postbox review-block tools, so another agent had to render PR drafts even when I authored their content.
- The shared machine needed coordination that the initial role setup did not provide. The lock wrapper at `.scratch/grooming/with-lock.sh` prevented full gates and browser runs from competing after agents observed load-related failures in issue #493.
- The working agreement improved during the sprint, but important rules arrived after work had begun. The required `Co-Authored-By: GPT-5.6 Sol <noreply@openai.com>` trailer forced history repair on the #468/#488, #486 and #466 branches rather than being part of branch setup.

## 2. Backlog grooming, estimation and planning

- Ranking by trust boundaries, data loss and the core agent loop put consequential work first. Issues #468, #208 and #439 were selected as P0 candidates because each could lose a person’s work or silently lose an agent handoff.
- Peer review corrected overclassification before execution. Issues #150, #189 and #240 were moved out of the immediate P0 set after the room compared concrete user impact rather than accepting the first urgency label.
- Blind planning poker reduced anchoring: my estimates were written independently under `.scratch/grooming/` before the room compared and revised them. Treating points as ordinal effort rather than “agent-days” kept the scale useful across different backends.
- The round plan was too optimistic about integration cost. PRs #511, #513 and #536 repeatedly had to absorb changes from `main`, including shared-file conflicts in `designs/intent.md` and `server/adapters/claude-stream.mjs`, after implementation estimates had effectively ended.
- I would reserve capacity for review repair and merge drift instead of planning only implementation. PR #522 needed several review rounds after its first focused tests passed, including commits `d1811486` and `3a03ff3`, which shows that green local tests were not a reliable completion estimate for cross-adapter behavior.

## 3. Execution

- Small, reversible commits made review and handoff work well. PR #513 separated permission extraction, normalization and whitespace correction (`cd133305`, `5ef77aab`, `f2a306bf`), so the integrator could inspect each concern without a broad rewrite.
- Red tests exposed requirement mistakes rather than only code defects. On issue #504, tests for direct topic requests, follow-ups and failed/stopped placeholders forced the `promptFirst` marker off permanent turn context and onto reply items before PR #511 merged.
- Adversarial runtime checks found defects that the focused suite missed. For PR #522 at `d1811486`, direct repros showed Stop left `{ running: true }`, Cancel followed by Retry replayed “Deploy production,” and one tool became `["Bash","Run deployment"]`; these became the three fixes ending at `3a03ff3`.
- Work waited most often at ownership boundaries. Issue #489 meant I could not publish review blocks, and PR #522 had to pause while I committed and pushed `d1811486` before developer could safely build on my uncommitted worktree.
- Status reporting sometimes overstated completion. Before my final #522 review, the summary said Stop called `settleScheduledWake` with `AbortError`; reading `Runtime.stop()` showed it bypassed `endTurn()` and left the schedule live. Acceptance should use code and readback, not the latest narrative.

## 4. Postbox itself

- Missing tool projection blocked normal collaboration. Issue #489 records that a Kiro session could have working model calls but no Postbox block tools, forcing review drafts and approvals through another agent.
- Wake controls could hide or strand work. Issue #439 covered a waiting wake card dropping additional wakes, while issue #492 and commit `6d9e012` show that removing limits entirely created runaway-loop risk and required a 50-wake backstop that resets when a chain ends.
- Prompt catch-up could displace the person’s actual request. Issue #504 and PR #511 fixed topic and historical side-thread turns so the direct request is the task and room catch-up is background context.
- Scheduled-wake state was too easy to copy and stale. PR #522’s move from a whole `scheduledWake` object to `scheduledWakeId` was necessary because Cancel, Retry, success and restart all need one authoritative persisted schedule.
- Long-lived sessions and summaries can omit consequential context. The room’s E4 result, recorded in the retrospective draft item `it_iGAMfc1J`, found that the old turn summary omitted a mention in 3.9% of this room’s summaries, which can break handoffs even when the underlying conversation is correct.

## 5. For the next sprint

- First, define “done” as an open, mergeable PR with the requested independent review and named gate evidence, not as code complete or focused tests green. PR #522’s progression through `67542d2`, `d1811486` and `3a03ff3` is the clearest evidence that implementation completion and acceptance were different milestones.
- Second, assign one integration owner per shared file and schedule merge-from-`main` checkpoints before final validation. PR #536 conflicted twice after approval because `designs/intent.md` and `server/adapters/claude-stream.mjs` were active in other PRs.
- Third, make capability checks part of room startup: verify each agent can read/write its worktree, run its required tests, and use Postbox collaboration tools before assigning work. Issue #489 was discovered only when a review draft needed a block.
- Keep blind estimates and independent review, but add explicit review-repair capacity to the sprint board. PR #513’s extraction work and PR #522’s integrator rounds show that review fixes were normal work, not exceptions.
- Continue evidence-first check-ins, but report only state transitions or breached promises. Researcher’s 17:39 UTC check-in in room item `it_c6kFAllt` was useful because it named the exact #522 requirement still open; repeated unchanged status announcements would add noise without changing a decision.
