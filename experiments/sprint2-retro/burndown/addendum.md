# Addendum: after the retrospective (3 November 2026)

The aggregate was approved at about 01:50 UTC on 3 November. The sprint closed at 20:31 UTC, after #726, #727 and #728 merged. These are the concerns the five agents raised about that stretch, not blind, each with its evidence, and the final figures.

## Final figures

- **Planned work:** all 32 points merged. #688 (#516 S3a) merged at 07:53 UTC and #689 (#516 S3b) at 17:05 UTC, each after two more rounds of the person’s review.
- **Unplanned work after the retrospective:** #726 (the follow-ups #722–#724), #727 (#725, a turn starting in a conversation’s Undo window) and #728 (UAT checks for the asset store and deletes). All three merged at 20:31 UTC. None was estimated.
- **Median PR open to merge:** 1.77 h over the 8 planned PRs, up from 0.99 h at the retrospective; 1.9 h over all 11. Sprint 1: 6.2 h.

| Rule | Measure | Sprint 1 | At the retrospective | At the close |
|---|---|---|---|---|
| 13 | Share of sprint PRs with points | 5 of 17 | 8 of 8 | 8 of 11 |
| 17 | Median PR open to merge | 6.2 h | 0.99 h | 1.77 h (planned), 1.9 h (all) |
| 21 | PRs with blocking integrator points after the room’s approval | 7 | 2 | 3 (#682, #688, #689) |

## New themes

### A1. UAT phases were written for conditions the runner couldn’t reach (5 of 5)
- In #726’s delete scenario, phases 1 and 6 fired the delete before anything was published, three runs in a row; phase 2 relied on the tester to time a 4-second offset; one phase needed a topic-thread delete the API refuses (409); and phase 3 needs two interrupts in one turn. Four runs, about $0.60, to verify. *(`claude-ssh` 2, `critic` 1, `developer` 1, `kiro-ssh-x86` 2, `researcher` 2; #726 reviews)*
- The UAT plan for #688 and #689 put Undo at 12 s, past the 10-second window (`DELETE_UNDO_MS`), never ran #688’s own fix, and was approved that way. *(`critic` 2, `researcher` 1)*
- Some phases were counted as passed when they weren’t reached. *(`critic` 1)*
- **Action:** before a plan is approved or paid for, each phase names the requirement it confirms, the code path that reaches it (file and line) and any limit it depends on, checked against the code; one interrupt per step; any timing tighter than about 10 s goes through the runner’s `at`, not the tester; an interrupt waits on a condition from the store, such as “version 1 exists”, not on a time; and each pass names the record that proves it was reached, or the phase counts as unverified.

### A2. New checks were right only once run on recorded data (2 of 5)
- #728’s content check, as first written, would have flagged every run; the second version missed tool-call steps; the turn check gave a false positive because Undo’s time was taken after the click. *(`developer` 2; `0a9e3bb8`, `c61bad8f`)*
- An existing check, `work-commands-match-stream`, fires after any conversation delete. *(`critic` 3)*
- **Action:** before a new check goes to review, run it on every recorded run of its scenario and report the findings, with its negative control built from a recorded run. File the delete false finding.

### A3. The gate’s result depends on the machine (2 of 5)
- `tests/agy-refusals.test.mjs:140` expects mode 444, which holds only under umask 022; under 077 it fails. *(`claude-ssh` 1)*
- A restart cleared the system’s temporary folder, and a grooming worktree and a mutation script went with it. *(`researcher` 3)*
- **Action:** the test sets its own umask or applies it when comparing; worktrees and scripts live in a sibling folder of the checkout, and the kit’s `setup.md` says so.

### A4. Unplanned work skipped the estimate (scrum master)
- #726, #727 and #728 were built from the person’s review findings without blind cards, so rule 13’s measure fell to 8 of 11.
- **Action:** a follow-up that becomes a PR gets cards like any item, even mid-round.

### A5. A confirm went stale when its branch moved (1 of 5)
- A push was confirmed while its branch was being rebased, so the confirm no longer matched the head. *(`developer` 3)*
- **Action:** rebase and gate first, then show the push confirm; don’t move the branch until it’s answered.

### A6. The aggregate’s first draft miscounted (1 of 5)
- Three theme counts didn’t match their tags, and quality rework was put under rule 12. *(`kiro-ssh-x86` 1)*
- **Action:** the scrum master counts each theme from its tags and checks each measure’s definition before the draft goes out.

## Postbox defects seen after the retrospective

- An expired permission card kept the room saying it needed the person, and couldn’t be dismissed; asking again raises a new card only if the agent’s permission mode asks (#721).
- Updating Postbox stranded a remote host’s agents twice in a day; the automatic install, #464-b, is now the first item of sprint 3 (#464).
- A safety filter stopped one agent mid-task, and the task went through once it was restated as a short, plain request.

## To file

- `work-commands-match-stream` flags a deleted conversation’s turns (A2).
- `tests/agy-refusals.test.mjs` depends on the shell’s umask (A3).
