# Sprint 3 retrospective: lead-host-install (#464-b)

My PRs: #736 (b1, merged 4 Nov 19:56 UTC), #755 (b2a, merged 5 Nov 18:13), #774 (recheck fix, merged 5 Nov 06:00), #770 (b2b, merged 6 Nov 02:51), #808 (b3, open at close, base now `main` at `addfe382`).

## 1. Setup

- **Helped:** critic's reads before the person. On #770 critic caught the missing `UNFIXED` mutant and the single-run browser count before the person saw the hand-back (critic's reply on `a53323c0`, and again on v2). Both were real gaps in my evidence.
- **Helped:** the shared test host and the UAT runner's staged-older option (#736). Each of #755, #770 and #808 ran its own UAT on its exact head, for $0.06–$0.16 each, and cleanup left the host clean every time (runs `2026-11-05T19-14-10`, `2026-11-06T01-53-46`, `2026-11-06T01-58-47-remotehosts`).
- **Got in the way:** one test host shared by all leads. #808's phase 5 rerun waited behind #780's `reviewfigures` run (22:24–22:36 UTC on 5 Nov), and lead-cards' #760 UAT waited behind my runs until after 18:00 local.
- **Got in the way:** subagents were little use on the late slices: the fixes were small and serial (rebase → gate → UAT → push), so I ran them myself. The pre-review packets for #755 and #770 were where subagents paid off.

## 2. Planning

- **Worked:** the endgame table and the freeze made the order explicit: #770 before #808, and #808's CodeQL only after a retarget (critic's ruling in the room after #783).
- **Would change:** the freeze's clock. Two hours of messages said "PDT" after daylight time ended on 1 Nov. I reported #808's 01:13 UTC push as 13 minutes late when it was 47 minutes early, and #826 was nearly punted on the same error (scrum-master's correction at 01:16 UTC). Every time should carry UTC.
- **Would change:** stacking. b2a → b2b → b3 meant every change to a lower PR cost a restack, gate and UAT on each one above it. #808 was restacked 7 times this sprint (heads `5ecc2a62` → `8bc5030b` → `3e750b28` → `c9aae48d` → `53c07651` → `b464a57b` → `9fffb64f` → `addfe382`).

## 3. Execution

- **Flowed:** gate → push → UAT → hand-back once the rebases stopped moving. On the last pass, #770 and #808 each went from rebase to pushed in under 3 minutes (Node 24 gate in about 50 s) before the 02:00 UTC freeze.
- **Waited:** on CI. Three red runs on my heads weren't my code's fault but had to be explained before anyone would read on: #755's consent-off test with a fixed 40 ms wait (CI on `3e750b28`, fixed in #770's `c961ce7c`), a browser shard cancelled at 20 minutes with no log (`0c88d6dc`, rerun after the person's confirm, s3-770-ci-rerun), and a race in my own new spec step (7 failures on `552b3996`, fixed in `0c88d6dc`).
- **Worst wait:** #770's merge, open from 4 Nov 21:08 to 6 Nov 02:51 UTC (about 30 h), across three integrator reviews (`5603dd08`, `c961ce7c`) and three rebases onto a moving `main`. The last rebase came from #760 merging minutes before critic's sign-off, which then had to be withdrawn.
- **Waited:** on myself, twice: a silent `until` loop got my turn stopped after 15 minutes with no output, and I kept polling CI by hand before switching to printed-progress monitors.

## 4. Quality: sent back after the room signed off

- **#755 at `dc600a59`:** a 127 heard while the consent was being turned off still installed, and Remove during an install left an orphaned token. Missed: an ordering test where the consent write races the rule. A test written from the design's failure table, one row per race, would have caught both.
- **#770 at `5603dd08`:** the card still showed a failed automatic install after the person's own Install… fixed the host. Missed: a probe of the card's state after a *different* actor fixed the host. Same check: a failure-table row for "something else fixed it".
- **#770 at `c961ce7c`:** my fix for that wrote `installed`, so the card claimed Postbox did it by itself, and the UAT trigger counted it. Missed: asserting what the card *says* (`updateShown`) rather than only what it no longer says. A test that names the expected outcome, not just the absent one, would have caught it. The same fix in #808 (`reinstalled`) had the same flaw, which I dropped.
- **#770's surviving mutants** (`supersedeTry`'s host check, `thisVersion`'s error note, `checkField`'s closure): my mutant list covered the guards I added, not the guards the fix depended on. Running mutants over every condition on the changed lines would have caught them.

## 5. Postbox and the hosts

- **Permission prompts:** every push, comment and body edit needed an "Allowed" from the person. That was right for GitHub writes, but it also covered reads such as "Read why the push was refused".
- **Silent waits stop the turn:** a 15-minute limit on output stopped my turn while I waited on #770's merge. Monitors that print each event, or a scheduled wake, fixed it.
- **The build host's load:** gates and UATs started at 23, 27 and 33 more than once (#770's UAT at 23 on `552b3996`, #808's at 27 on `9fffb64f`, a Node 22 run at about 33 whose one failure didn't reproduce). The lock serialises gates but not UATs or other agents' work.
- **A worktree's `node_modules` emptied** at 00:54 UTC on 6 Nov while a per-commit Biome script linked to it. I reinstalled it; the cause is a guess (an `npm ci` overlapping the link).
- **Retargeting doesn't start CI:** a stacked PR moved to `main` keeps its old checks, so CodeQL never runs. #808's base is now `main` (since #770 merged), with no CodeQL on `addfe382`. A close and reopen didn't start CodeQL on #783 either: it still lists the same 17 checks (lead-delivery, after the reopen). So the way to get CodeQL on a retargeted head is still unknown.

## 6. For sprint 4, in order

1. **Finish #808:** first find what starts CodeQL on a PR retargeted to `main`, since a close and reopen didn't on #783 (likely a new commit on the head, unverified). Then CodeQL on #808, the body to the person, and critic's sign-off.
2. **Don't stack more than one PR deep on an unmerged branch.** Land each slice before building on it, or keep the next slice's commits local until the one below merges.
3. **Write the failure-table tests first, one per row, including "something else fixed it" and "the person did it, not Postbox", and assert the exact outcome shown.** Then mutate every condition on the changed lines, not only the new guards.
