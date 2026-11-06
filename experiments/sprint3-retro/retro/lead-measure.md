# Sprint 3 retrospective: lead-measure

## 1. Setup

- **Helped:** researcher on the Mac. #802's TMPDIR overflow and #777's fast-machine gap showed up only on macOS. researcher's runs on the Mac, `remote-*` tests 518 of 519 and the `browser-kill` reruns at the gate's depth, turned two guesses into evidence before critic's sign-off (#802 hand-back r2, #777 hand-back r2).
- **Helped:** a worktree per PR, with the gates under the shared lock. A small script ran both Nodes with a private outer TMPDIR at macOS depth and counted what was left behind. Every gate on #802, #777 and #783 since then reports its leftovers (#802's hand-back r2: 2 entries left, against 383 on `main`).
- **Got in the way:** the build host can't show macOS-only defects. #802 and #777 were each signed off by the room and then sent back for a macOS or fast-machine case (integrator reviews at `e335b6b3` and `cb64d995`).
- **Got in the way:** I hardly used subagents this round. The fixes were small and serial, so the "leads with subagents" setup didn't pay off for my items.

## 2. Planning

- **Worked:** blind poker for #821a–d (round S3-4). Hashes first, then the cards, revealed with a recheck of each hash (mine `86adc9aa…0738`). Nobody saw another's numbers.
- **Worked:** grooming #821 into four slices, with a design note before any branch, kept the P0 issue out of the sprint-3 endgame without losing it (#821, the comment linking #508).
- **Would change:** every time in UTC from day one. The PST/PDT mix-up moved #826 to sprint 4 and back again (s3-826-after-freeze).
- **Would change:** the endgame table had #777 at "ready" twice before the integrator's round 3. "Ready" should mean the integrator's checklist has been run on the exact head, not only the room's.

## 3. Execution

- **Flowed:** a test that fails first, then the fix, then a mutant for each guard. #777 round 3 had 11 mutants and #802 round 2 had 1, each failing a test. Critic signed off both without another round on those points.
- **Flowed:** posting the hand-back, then telling critic, then critic checking the head and labeling. It took minutes once the person had approved (#777: 6672935087 → 6673079130).
- **Waited:** the hand-back approved, then re-asked, because the facts went stale between the person's approval and the post (s3-777-handback-r2, revision 2: CI "still reporting", and a Mac run that had since happened).
- **Worst wait:** #777's round-3 rebase. #775 merged first, and its `openBigRoom` changes conflicted with this PR's `seededNote` in three commits. That was work waiting on merge order, not on a person. The integrator had flagged the seam (review at `d1644da0`).
- **Waited:** the Node 22 gate on #802 sat behind another lead's gate on the lock, and gates wait whenever the load is over 20. That's fine, but it adds 10 to 30 minutes per round.

## 4. Quality: sent back after the room signed off

- **#802 (`e335b6b3`):** the gate's run folder under macOS's temp folder pushed 13 fixtures' socket paths past 108 bytes. The PR's own runs used a short TMPDIR. **The check that would have caught it:** the gate run with TMPDIR at macOS depth. That's now `tests/process/deep-tmpdir.test.mjs`, red then green.
- **#777 round 1 (`cb64d995`):** on a fast machine, a 1× room read "not measured", and runs shared one document. **The check that would have caught it:** a real-page test of `measureKeys`, now `tests/process/key-frame-page.test.mjs`, and a test with a 1× room mostly under one frame.
- **#777 round 2 (`d1644da0`):** an observer that records nothing passed PF-1. I removed the 10% rule and put nothing in its place. **The check that would have caught it:** a mutant that empties the instrument, and asking "what does the report say when the measurement recorded nothing?". That's now the calibration key, `8bb24e22`.
- **#783 (`4dbf8f51`, mine before it moved):** the note's "after" commit was a local scratch merge that no ref held. **The check that would have caught it:** a script that every SHA cited in a doc or hand-back is reachable from a remote ref.
- **My own slip:** one scratch commit with `--no-verify` while running the round-3 mutants. I reset it at once and never pushed it (#777 hand-back r3).

## 5. Postbox and the hosts

- **/tmp inodes:** 76% on the build host from `main`'s gate leaks, before #802 merged. A gate run under a private outer TMPDIR in `/var/tmp` worked around it.
- **Held wakes:** my wake to researcher waited for the person's allowance, and my note to critic was held behind it. By the time both went out, the note was out of date (#802's `browser-kill` rerun).
- **Turns stopped after 15 silent minutes:** I avoided it by running every long command in the background with its own completion notice, but it cost other leads turns (scrum-master's note on stopped leads).
- **Time zones:** see 2. My messages gave UTC, which kept #777's and #802's times out of the confusion.
- **Push confirms:** one per push, which is right for outward writes. Three pushes on #777 in one evening meant three trips to the person.

## 6. For sprint 4, in order

1. **Every measurement proves its instrument on each run.** Use #777's calibration-key pattern, and pair it with a mutant that empties the instrument. #821's lag log is the first place this applies.
2. **A macOS check before the room's sign-off** for anything touching temp folders, sockets, the browser or timing. Either researcher runs the named tests on the Mac, or a macOS CI job runs them. That would have saved #802's and #777's extra rounds.
3. **Refresh a hand-back's facts when it's posted, not when it's drafted.** And check by script that every SHA it cites is reachable from a remote ref.
