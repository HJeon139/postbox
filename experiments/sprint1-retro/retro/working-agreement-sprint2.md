# Working agreement for sprint 2 (proposed, 29 October 2026)

This supersedes `../grooming/working-agreement.md`. It keeps the rules that still apply, retires two, restates one, and adds the sprint 1 retrospective’s actions (`aggregate.md`) as rules, each naming its theme. A rule with **Measure** says how the next retrospective checks it, against sprint 1’s figure. Every term in **bold** at a rule’s start is defined in the glossary at the end.

## Evidence and reporting

1. **Evidence.** Cite the command that proved a claim, and its exit code. A count of zero or “nothing found” is a finding about the tooling until it’s explained. A search that errors is reported as failed. A process search leaves out the searching command.
2. **Status claims cite a readback or a test,** not an implementer’s summary (theme 16).
3. **UAT runs.** Report a run only after its process has exited, with its exit code and figures from the final `report.md`.
4. **CI waits.** Don’t hold a turn open for CI: post when `npm run check` exits 0 locally, and check CI from a scheduled wake.
5. **Check-ins** report changes of state and broken promises only, not unchanged status (the aggregate, “where the answers differ”).
6. **Glossary.** The first time a room message uses a coined term, an abbreviation or an identifier the reader may not know (a rule number, a block id, a branch’s purpose, a check’s name), its author defines it with `define_term`. The scrum master keeps the glossary at the end of this file current. *(The person’s request, 29 October.)*

## People and hand-offs

7. **Blockers and silence.** Before calling anyone blocked or silent, read back through the room and ask them. Give work to a free agent when one is busy.
8. **Cards first.** A card waiting on the person blocks every agent’s @-mentions. The scrum master raises any such card to the person within 30 minutes, and an agent whose mention “woke no one” resends it as soon as the card is answered (theme 1). **Measure:** the longest time any hand-off waited on a card; sprint 1: 7 hours, 08:33–15:49 UTC 29 Oct.
9. **Each agent shows its own drafts,** and reports the exact call and error if it can’t. If its Postbox tools are missing (#489), the person may choose another agent to show its text unchanged, as on 28 October.
10. **Writes outside the room** are shown as a draft first, unless the person says to publish directly. A draft whose head or figures moved after approval may be posted with a small, stated change; anything more is shown again (`aggregate.md`, action 10).

## Room setup

11. **Start-of-room checks, observed.** Before an agent gets its first item, it shows a one-line choice block and runs `npm run check` once on its own host; the scrum master checks its role in its session record. A role change gets a fresh session (theme 4). **Measure:** agents that found a missing tool or wrong role after their first branch; sprint 1: 3 (gpt’s tools, two roles).
12. **Rules before branches.** The working agreement, commit format and trailers are settled before any branch is made (theme 15). **Measure:** branches rewritten for a rule that arrived late; sprint 1: every branch open when the trailer rule arrived on 28 October.

## Planning

13. **Estimate everything,** hotfixes included, with the scale in `../grooming/poker-round2.md` and blind cards. Plan to the room’s measured velocity (`sprint-mechanics.md`, §6) (theme 7). **Measure:** the share of sprint PRs with points; sprint 1: 5 of 17.
14. **Every planned item has an owner and a time,** experiments included; one not started by its time is replanned or dropped with a reason (theme 10). **Measure:** planned items that never started; sprint 1: 4 experiments (E1, E3, E5, E6).
15. **Settle each decision, edges included, before building it,** as a choice block with the alternatives and their costs (theme 13). **Measure:** items rebuilt after a decision changed; sprint 1: 1, #492, built three times.
16. **A merge plan before the round:** for each item, the files it changes and its merge order; items that share a file are ordered or combined (theme 3). **Measure:** merges of `main` into an open PR to resolve a conflict; sprint 1: about 8.
17. **The person’s review time is planned:** a review slot per round, and at most 4 PRs waiting on the person’s review at once (critic’s review of the retrospective). **Measure:** median time from PR open to merge; sprint 1: 6.2 h.

## Building and validating

18. **Load.** One full browser run at a time (`with-lock.sh browser`), at most two `npm run check` at once, and a full gate takes the browser lock too. Rerun a failure under load once alone, and name it, before calling it flaky.
19. **Gates before acceptance.** A head goes to acceptance review, PR-ready status or merge only after its own full gate under both locks, `node tools/lint-commits.mjs`, `npx biome check`, and a red run against its parent head. A work-in-progress hand-over is allowed if labeled as one (themes 11, 14). **Measure:** heads handed to review that then failed the gate; sprint 1: 3.
20. **Who tests what.** Authors own their tests, gate and both browser runs. Tester owns UAT and the integration branch’s regression pass, and on each head runs: a red run of each new test, saying when it isn’t truly red; a mutation that removes each new guard; a stress run (10 runs in fresh processes, specs also with `POSTBOX_STREAM_LAG=300`); and a two-way diff of any moved code (theme 2). Critic checks that each report’s head and exit codes match what’s pushed.
21. **Review checklist.** The author merges today’s `main` and checks the edge paths before asking for review. The reviewer checks other backends, slash and attach turns, Retry and restart, non-ASCII and long tokens, moved code both ways, and the branch merged with `main` (`git merge-tree` and the size lint); every finding cites the line it read (themes 2, 5). **Measure:** PRs with blocking integrator points after the room’s approval; sprint 1: 7.
22. **An early integrator checkpoint** on each PR’s risky paths, before repeated full validation, scheduled by the scrum master with the person (theme 5).
23. **No push on a head under review without saying so;** reviewers review the newest head named in the room (theme 12). **Measure:** reviews that crossed a newer push; sprint 1: at least 4.
24. **Order-sensitive fixes** name their deterministic `node:test` test before a paid UAT; a UAT confirms, a deterministic test decides.
25. **Test-run budget.** Real-agent test runs are approved up to $100 in all without asking; each report says its cost.

## Done

26. **Definition of done.** An item is done when its PR is open, after critic and tester approve it, with a `Co-Authored-By` trailer and one `Fixes #n` or `Refs #n` line per issue on every commit, and the design-doc rows it affects updated.

## Retired

- Old rule 6, “Until #484 is fixed, read back when a summary leaves items out”: #484 merged (PR #500). Rule 7 still asks for a read-back before calling anyone silent.
- Old rule 12, “#439 merges first”: it merged (PR #497).

## Glossary

| Term | Meaning |
|---|---|
| **card** | A Postbox block that waits on the person, such as a wake card past the chain limit, or a card asking to add an agent |
| **chain limit** | After 50 agent wakes in one chain with no message from the person, the next waits on a card; the count resets when a chain ends (#492) |
| **red run** | Running a new test against the code without its fix, to show it fails |
| **mutation run** | Removing one new guard or condition, to show some test fails without it |
| **stress run** | Running a test 10 times in fresh processes, and specs also with `POSTBOX_STREAM_LAG=300` |
| **the gate** | `npm run check`, plus both browser runs for a visible change |
| **integration branch** | A local branch where approved heads are merged and the gate run once |
| **integrator review** | The person’s review on GitHub, before merge |
| **blind cards** | Estimates each estimator writes to its own file without opening the others’ |
| **work-in-progress hand-over** | A pushed head given to another agent to finish, labeled as not ready for review |
