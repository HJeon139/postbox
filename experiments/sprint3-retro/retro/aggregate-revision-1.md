# Sprint 3 retrospective: aggregate (revision 1, 6 November 2026)

Seven blind answers, each checked against the hash its author posted before anyone read the others: critic `be6eaec7`, researcher `91d81971`, lead-host-install `f4775286`, lead-cards `636b0816`, lead-delivery `1cc8f76c`, lead-transcript `c7c9c1ca`, lead-measure `f61393ee`. Postbox stores each asset under its sha256, and all 7 matched (`shasum -a 256`). critic and lead-host-install replaced their first hashes (`305af357`, `cbf2a55d`) before the reveal, to correct one fact: a close and reopen does not start CodeQL (#783).

A source like **deliv 3.2** means lead-delivery’s answer, question 3, bullet 2. The tags are crit, res, host, cards, deliv, trans and meas. A theme’s count is the number of agents its tags name. Revision 2 will take every agent’s line comments.

## The sprint

Two lanes ran from 3 to 6 November: the hotfix lane and #508’s close-out. Five leads on the build host each worked with subagents, and critic and researcher worked on the Mac. The person was the only reviewer and merger.

| Measure | Sprint 1 | Sprint 2 (burndown, at close) | Sprint 3 | Command |
|---|---|---|---|---|
| PRs merged | 17 | 11 | 25, plus 2 chores; 4 open at close | `gh pr list --state merged --search "merged:>=2026-11-03T21:15:00Z"`, exit 0 |
| Points merged | n/a | 32 | 91, in 23 PRs | the board (`s3-board` v64) |
| Median PR open → merge | 6.2 h | 1.77 h (planned), 1.9 h (all) | **11.9 h** over the 25 (4.7–57.8 h); 11.7 h with the chores | same list, `createdAt` → `mergedAt` |
| PRs the integrator requested changes on | 7 | 3 (#682, #688, #689) | **12** (15 requests): #743, #755, #758, #760 ×2, #770 ×2, #775, #776, #777 ×2, #781, #783, #802, #825 | `gh api …/pulls/<n>/reviews`, state `CHANGES_REQUESTED`, exit 0 |
| Labels removed for a red check | n/a | n/a | 1 (#775, CodeQL) | room record, 5 Nov |

The room merged more than twice sprint 2’s PRs and nearly three times its points. Each PR took more than six times as long to merge, though, and four times as many came back from the person’s review.

## What worked, to keep

- **A fresh-subagent pre-review packet before critic** found P1s the authors had missed: #780’s orphaned blobs (about 200 MiB after 10 refused calls), #826’s stale open-asks count after `item.move`, and three ways #781’s tie rule would misbehave. **cards 1.2, trans 1.1, deliv 1.3, crit 1.1**
- **critic’s reads against the code, not the prose,** found real defects: #780’s staged-put data loss, #781’s dead-need case (R8), and #826’s whole-page `getElementsBy…` lookup. **cards 1.3, deliv 1.1, trans 1.2, host 1.1**
- **researcher on the Mac** turned macOS guesses into red and green runs: #775 went from 6 of 70 failing to 140 of 140 passing, plus #802’s remote tests and #806 in a full Postbox turn. **res 1.1, trans 1.3, meas 1.1**
- **Blind poker** settled rounds S3-2c, S3-2d, S3-3 and S3-4 with no re-vote. Grooming #821 into four slices, with a design note first, kept a P0 out of the endgame without losing it. **res 2.1, meas 2.1, meas 2.2**
- **The endgame table, checkpoints and the 02:00 UTC freeze** gave each lead a hard target and an order. The carve-out for checks on pushed heads let #760’s UAT run after the freeze. **cards 2.1, cards 2.2, deliv 2.1, host 2.1, trans 2.1, res 2.3, crit 2.1**
- **A failing test first, then a mutant per guard.** #777’s round 3 had 11 mutants. The integrator wrote 36 mutants against #825, and 32 of them failed a spec. **cards 3.1, meas 3.1**
- **The person’s rule that a red check means not ready** removed every “noted” exception after #775. **crit 2.2**
- **The staged-older UAT option** (#736) let each host PR run its own UAT on its exact head, for $0.06 to $0.16 each. **host 1.2**

## Where the answers agree

### T1. Times without UTC moved a decision (7 of 7)
- Messages said “PDT” after daylight time ended on 1 Nov, an hour ahead. Pushes at 01:13 UTC were reported as late when they were 47 minutes early, and #826 was nearly punted (s3-826-after-freeze). **crit 2.3, crit 5.2, res 2.4, host 2.2, cards 2.3, deliv 2.2, trans 2.3, meas 2.3**
- The build host’s clock said 17:14 PST while another lead’s message said 18:14 PDT for the same moment. **deliv 2.2**
- **Action (adopted, 1):** every time in UTC; a local time may follow as an offset, never as a zone name.

### T2. A turn silent for 15 minutes is stopped, with its background runs (7 of 7)
- lead-delivery was stopped three times, and lead-host-install’s `until` loop once. A CI watcher that printed only at the end was also stopped. **deliv 3.5, deliv 5.2, host 3.4, host 5.2, cards 5.2, crit 3.4, crit 5.3, res 5.6, meas 5.3**
- The background runs went with the turn: #775’s lagged run was cut at 493 of 566, #826’s lagged run ended before its first test, and a CI watcher died. **trans 1.4, trans 5.1**
- researcher found the source: Postbox’s own stall stop for remote turns, at `turns-resume.mjs:32` (“Stopped: no output for N min”). *(Found after the blind answers.)*
- **Action (adopted, 10):** a background job outlives its stopped turn, or a printing job keeps its turn (Draft C). **trans 6.1, deliv 6.2**

### T3. A permission card for every git and gh call (7 of 7)
- 48 cards in one evening: 44 of them for git or gh, 39 of those from host turns. **res 5.1, crit 5.1, cards 1.4, cards 5.1, host 5.1, deliv 5.5, trans 5.5, meas 5.5**
- Pushes and posts should keep a confirm, but reads such as `gh pr checks` should not need one. A push also got a second prompt after its confirm. **host 5.1, deliv 5.5, meas 5.5**
- **Action (adopted, 2):** a read-only allow list for review commands, built on the generic allow list after #817, because a mod can approve a call before Postbox sees it. **crit 6.1, res 6.1**

### T4. Stacked PRs and a moving `main` (6 of 7)
- #808 was restacked 7 times and #773 rebuilt 4 times. #825 was rebased three times in an hour. Each restack or rebase meant another gate, browser runs and UAT. **host 2.3, deliv 1.4, cards 3.2, trans 2.4**
- Merge order caused waits: #770 conflicted once #760 merged, and its sign-off had to be withdrawn. #777 conflicted with #775’s `openBigRoom`. #783’s PF-1 had to be rerun after #777’s round 3. **crit 3.3, meas 3.4, deliv 2.3, host 3.3**
- A retarget to `main` doesn’t start CodeQL, and a close and reopen didn’t either (#783 still lists 17 checks). **crit 2.4, host 5.5, deliv 3.4**
- **Action (adopted, 4):** stack at most one deep; rebase once, right before the final gate; and find what starts CodeQL on a retargeted PR. **host 6.2, trans 6.3, crit 6.3, deliv 6.3**

### T5. The send-backs shared one shape (5 of 7)
- **A writer, reader or caller of a changed value wasn’t grepped again:** #760’s `store-outage.mjs` passed `by: 'you'`; #770’s `installed` was read by the card and the trigger; #781 introduced a name `main` already had. **cards 4.2, crit 4.2, crit 4.3, host 4.3, deliv 4.1**
- **A failure case had no test:** #755’s consent write raced the rule; #770 had no case for the host being fixed by someone else; #760 had no case for a stop that wasn’t the person’s. **host 4.1, host 4.2, cards 4.1**
- **The test checked that the old outcome was gone, not what the new one is:** #770’s card. **host 4.3**
- **An instrument was never proved:** #777’s observer recorded nothing and still passed PF-1. **meas 4.3, crit 4.1, res 4.3**
- **Hostile input wasn’t tested:** #825’s alt escape survived its mutant, because every test alt was plain text. **cards 4.4**
- Mutants covered only the new guards, not every condition the fix depended on (#770). **host 4.4**
- **Action (adopted, 5):** test design in the pre-review packet, in parts (a) to (f). **host 6.3, cards 6.2, meas 6.1**

### T6. The build host’s load and one test host (6 of 7)
- Gates waited on loads of 20 to 76, or started too high (23, 27, 33, 47, 59). A Node 22 timing test failed at 47 and passed at 18. **deliv 3.3, deliv 5.3, host 5.3, trans 1.5, trans 3.5, meas 3.5**
- One test host for every lead’s UATs meant waits. #760’s UAT waited from 00:29 to 01:14 UTC, and #808’s waited behind `reviewfigures`. **cards 1.5, host 1.3**
- The Mac ran at a load of 23 to 50 all afternoon, so #777’s under-one-frame rule never ran live (#818). **res 1.3**
- **Action:** none adopted on its own. The gate script (T10) waits for the load inside the lock.

### T7. Hand-backs went stale, and each GitHub write ran in series (4 of 7)
- Facts went stale between drafting and posting: s3-777-handback-r2 was asked again, because CI and the Mac run had changed. #780’s “four items done” arrived at a head without the P1 fix. **meas 3.3, crit 1.4**
- Every write went through critic and then the person, so a single added line needed another round trip. #773’s hand-back was still waiting on the person at the close. **cards 3.3, deliv 3.2**
- **Action (adopted, 7, its second half):** a hand-back’s facts are refreshed when it’s posted. **meas 6.3**

### T8. Messages and wakes arrive late (4 of 7)
- researcher’s #775 and #777 results waited behind lead-measure’s held wake, and twice reached a lead that had been stopped. **res 1.4, meas 5.2, trans 3.2**
- A message to a busy agent arrives after the work it asks for is done, so replies cross. **trans 5.2, res 3.5**
- A host’s queued tool calls fail silently (#827). A block update was refused while the person’s answer was still unread. **cards 5.3, cards 5.5**
- **Action:** none adopted. #803 and #827 are filed.

### T9. Cited commits that aren’t on GitHub (3 of 7)
- #783’s note cited an “after” commit, `99c15ffa`, that no ref held. #826’s full browser run was on an unpushed head, `ba196c81`, and its timings were on heads from before the rebase. **deliv 4.3, meas 4.4, trans 4.3**
- **Action (adopted, 7):** a script checks that every cited SHA is on a remote ref (Draft B). **deliv 6.1, meas 6.3**

### T10. Hand-rolled gate and sign-off scripts failed quietly (3 of 7)
- critic’s sign-off script posted a label over a `merge-tree` conflict, and before that it didn’t gate on the per-commit result. **crit 1.3**
- One gate exited 69 inside a job that reported 0. A spec list passed as one zsh word ran no tests. A Biome run piped through `grep` hid its exit code. **trans 3.3, deliv 1.2**
- **Action (adopted, 3):** one shared gate and sign-off script that waits, prints, and fails loudly (Draft A). **crit 6.2, trans 6.2, deliv 6.2**

### T11. macOS-only defects were found after sign-off (3 of 7)
- #802’s TMPDIR depth, #777’s fast machine and #775’s DevTools viewport each came back from the person. **meas 1.3, meas 4.1, meas 4.2, trans 4.1**
- **Action (not adopted, 6):** a Mac check before sign-off. **meas 6.2, trans 6.3**

## Where the answers differ

- **Close and reopen for CodeQL:** lead-delivery’s action 3 still recommends it, because the file was hashed before the reopen was tried. critic, lead-host-install and lead-delivery’s own message after the reopen show it didn’t work on #783. **deliv 6.3** against **crit 2.4, host 5.5**
- **Subagents:** critic, lead-cards and lead-transcript found them the most useful part of the setup. lead-host-install and lead-measure hardly used them, because their late fixes were small and serial. **crit 1.1, cards 1.1, trans 1.1** against **host 1.4, meas 1.4**
- **Push prompts:** lead-delivery and lead-measure say a confirm on each push is right, and only the second prompt is waste. critic and lead-cards want a standing allow for their own branches. **deliv 5.5, meas 5.5** against **cards 5.1, crit 6.1**

## Single-source points worth keeping

- **Split a large item before its branch exists.** #780 became a design note, five security parts, a host path, two UATs and 44 commits as one item. **cards 2.4, cards 6.3**
- **Measure before carding.** #564-b1 was carded 8 on its first scope, then 5 after lead-transcript measured. **res 2.2**
- **A question waiting on another agent needs an owner and a deadline.** The allow-list draft waited all sprint on four unanswered questions, and #671-b’s did too. **res 3.2, res 3.3, res 6.3**
- **“Ready” should mean the integrator’s checklist was run on the exact head.** #777 was “ready” twice before round 3. **meas 2.4**
- **A priority question with no default on every issue draft.** **res 2.5**
- **A stale cherry-pick state** in a worktree from an earlier day blocked `git switch`. **deliv 1.5**
- **A worktree’s `node_modules` emptied** mid-run, cause unknown (it’s a guess). **host 5.4**
- **`write_asset` on a remote host takes text only,** so the published text and the scanned file can drift. **trans 5.3**
- **The UAT runner settles every agent before each tester step,** so a phase that pages while a reply streams can’t be played (#805). **deliv 4.5, deliv 5.1**

## The working agreement’s measures

Measured against sprints 1 and 2, as the sprint 2 agreement’s rules name them.

| Rule | Measure | Sprint 1 | Sprint 2 (close) | Sprint 3 |
|---|---|---|---|---|
| 13 | Share of sprint PRs with points | 5 of 17 | 8 of 11 | 23 of 25 (#774 and #735 have none) |
| 17 | Median PR open to merge | 6.2 h | 1.77 h | 11.9 h |
| 21 | PRs with blocking integrator points after the room’s approval | 7 | 3 | 12 |
| 23 | Reviews that crossed a newer push | at least 4 | not counted | at least 2 (#770’s sign-off over #760’s merge; critic’s r2 read of the lag issue against r3) **crit 3.3, res 3.5** |

## Filed during the sprint

This room’s filings, as the answers and the room record name them: #779, #782, #789, #796, #797, #799, #800, #803, #804, #805, #806, #807, #814, #815, #817, #818, #820, #821, #822, #827, #828. The repository had 70 issues created in the sprint window, from every room (`gh issue list --state all --search "created:2026-11-03T21:15:00Z..2026-11-06T03:09:00Z"`, exit 0).
