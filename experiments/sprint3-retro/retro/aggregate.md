# Sprint 3 retrospective: aggregate (revision 2, 6 November 2026)

Seven blind answers, each checked against the hash its author posted before anyone read the others: critic `be6eaec7`, researcher `91d81971`, lead-host-install `f4775286`, lead-cards `636b0816`, lead-delivery `1cc8f76c`, lead-transcript `c7c9c1ca`, lead-measure `f61393ee`. Postbox stores each asset under its sha256, and all 7 matched (`shasum -a 256`). critic and lead-host-install replaced their first hashes (`305af357`, `cbf2a55d`) before the reveal, to correct one fact: a close and reopen does not start CodeQL (#783).

A source like **deliv 3.2** means lead-delivery’s answer, question 3, bullet 2. The tags are crit, res, host, cards, deliv, trans and meas. A theme’s count is the number of agents its tags name. Revision 2 takes in all 40 line comments on revision 1: critic 4, researcher 8, lead-host-install 5, lead-cards 5, lead-delivery 6, lead-transcript 5 and lead-measure 7. Where an answer’s own text is wrong, the file stays as hashed and the correction is noted here.

## The sprint

Two lanes ran from 3 to 6 November: the hotfix lane and #508’s close-out. Five leads on the build host each worked with subagents, and critic and researcher worked on the Mac. The person was the only reviewer and merger.

| Measure | Sprint 1 | Sprint 2 (burndown, at close) | Sprint 3 | Command |
|---|---|---|---|---|
| PRs merged | 17 | 11 | 25, plus 2 chores; 4 open at close | `gh pr list --state merged --search "merged:>=2026-11-03T21:15:00Z"`, exit 0 |
| Points merged | n/a | 32 | 91, in 23 PRs | the board (`s3-board` v64) |
| Median PR open → merge | 6.2 h | 1.77 h (planned), 1.9 h (all) | **11.9 h** over the 25 (4.7–57.8 h); 11.7 h with the chores | same list, `createdAt` → `mergedAt` |
| PRs the integrator requested changes on | 7 | 3 (#682, #688, #689) | **12** (15 requests): #743, #755, #758, #760 ×2, #770 ×2, #775, #776, #777 ×2, #781, #783, #802, #825 | `gh api …/pulls/<n>/reviews`, state `CHANGES_REQUESTED`, exit 0 |
| Labels removed for a red check | n/a | n/a | 1: `ready for integrator` off #775 at 16:44:53 UTC on 5 Nov, after its CodeQL upload failed | `gh api repos/HJeon139/postbox/issues/775/events`, exit 0 |

The room merged more than twice sprint 2’s PRs and nearly three times its points. Each PR took more than six times as long to merge, though, and four times as many came back from the person’s review. *(host 3.3 counts three integrator reviews on #770 but names two heads; the table’s two is right.)*

## What worked, to keep

- **A fresh-subagent pre-review packet before critic** found P1s the authors had missed: #780’s orphaned blobs (about 200 MiB after 10 refused calls), #826’s stale open-asks count after `item.move`, and three ways #781’s tie rule would misbehave. **cards 1.2, trans 1.1, deliv 1.3, crit 1.1**
- **critic’s reads against the code, not the prose,** found real defects: #780’s staged-put data loss, #781’s dead-need case (R8), and #826’s whole-page `getElementsBy…` lookup. **cards 1.3, deliv 1.1, trans 1.2, host 1.1**
- **researcher on the Mac** turned macOS guesses into red and green runs: #775 went from 6 of 70 failing to 140 of 140 passing, plus #802’s remote tests and #806 in a full Postbox turn. **res 1.1, trans 1.3, meas 1.1**
- **A worktree per PR, and a gate run that counts what it leaves behind.** It ran both Nodes under the lock with a private TMPDIR as deep as macOS’s. #802’s hand-back could then show 2 entries left against 383 on `main`, and its macOS socket overflow was reproduced on Linux before the Mac run. **meas 1.2**
- **UAT on the exact head paid for itself.** #825’s own run (`2026-11-05T21-52-48-reviewfigures`) caught a host refusal that never reached the agent, before the integrator’s review. It was fixed in `b82e930b`, and the class is #827. The staged-older option (#736) let each host PR run its own UAT for $0.06 to $0.16. **cards 4.5, host 1.2**
- **Blind poker** settled rounds S3-2c, S3-2d, S3-3 and S3-4 with no re-vote. Grooming #821 into four slices, with a design note first, kept a P0 out of the endgame without losing it. **res 2.1, meas 2.1, meas 2.2**
- **The endgame table, checkpoints and the 02:00 UTC freeze** gave each lead a hard target and an order. The carve-out for checks on pushed heads let #760’s UAT run after the freeze. **cards 2.1, cards 2.2, deliv 2.1, host 2.1, trans 2.1, res 2.3, crit 2.1**
- **A failing test first, then a mutant per guard.** #777’s round 3 had 11 mutants. The integrator wrote 36 mutants against #825, and 32 of them failed a spec. **cards 3.1, meas 3.1**
- **The person’s rule that a red check means not ready** removed every “noted” exception after #775. **crit 2.2**

## Where the answers agree

### T1. Times without UTC moved a decision (7 of 7)
- Messages said “PDT” after daylight time ended on 1 Nov, an hour ahead. Pushes at 01:13 UTC were reported as late when they were 47 minutes early, and #826 was nearly punted (s3-826-after-freeze). **crit 2.3, crit 5.2, res 2.4, host 2.2, cards 2.3, deliv 2.2, trans 2.3, meas 2.3**
- The build host’s clock said 17:14 PST while another lead’s message said 18:14 PDT for the same moment. **deliv 2.2**
- **Action (adopted, 1):** every time in UTC; a local time may follow as an offset, never as a zone name.

### T2. A remote turn silent for 15 minutes is stopped (7 of 7)
- lead-delivery was stopped three times: once for a silent CI watcher, and twice for bench and check chains whose watchers didn’t print. lead-host-install’s `until` loop was stopped once. **deliv 3.5, deliv 5.2, host 3.4, host 5.2, cards 5.2, crit 3.4, crit 5.3, res 5.6, meas 5.3**
- Background runs ended with the turn’s session: #775’s lagged run was cut at 493 of 566, #826’s lagged run ended before its first test, and a CI watcher died. A run started with `nohup` survived: #826’s lagged rerun on `12236b60` ran detached and passed 573 of 573. **trans 1.4, trans 5.1**
- **The source** (found after the blind answers): Postbox’s own `checkStalls` (`server/remote/turns-resume.mjs:21–35`) stops a remote turn with no new line for the host’s `stallTimeout` (`shared/remote-settings.mjs:29`, 15 minutes by default, 10 minutes to 24 hours). Kiro turns are excused while a tool call runs. Claude Code turns aren’t, because the code relies on Claude Code printing `tool_progress` heartbeats every 30 s during a quiet tool call (`server/adapters/claude-code-remote.mjs:28–37`; a recorded fixture, `tests/fixtures/claude-code/background-moved.jsonl`). Why the heartbeats stopped is unconfirmed. One guess is waits on a background task or a monitor.
- **Action (adopted, 10):** detaching a long run with `nohup` and a progress file is a rule now. Draft C covers the other half: a quiet tool call on a Claude Code host keeps its turn. Its first step is to find, from the stopped turns’ lines and the host stream log, when the heartbeats stop. Workaround now: raise the host’s “Stop a quiet turn after” setting. **trans 6.1, deliv 6.2**

### T3. A permission card for every git and gh call (7 of 7)
- 48 cards in one evening: 44 of them for git or gh, 39 of those from host turns. **res 5.1, crit 5.1, cards 1.4, cards 5.1, host 5.1, deliv 5.5, trans 5.5**
- Reads such as `gh pr checks` shouldn’t need a card. A push keeps its confirm, which costs a trip to the person each time: three pushes on #777 in one evening meant three trips. After a push was confirmed, it got a second “Allowed” prompt as well. **host 5.1, meas 5.5, deliv 5.5**
- **The allow list and #817 are one boundary.** #806 showed, in a full Postbox turn, that a Claude Code mod approving a call lets an agent’s `git push` past the card with no line in the room. That’s #817, at P1. **res 5.2**
- **Action (adopted, 2):** a read-only allow list for review commands, built on the generic allow list after #817. **crit 6.1, res 6.1**

### T4. Stacked PRs and a moving `main` (6 of 7)
- #808 was restacked 7 times; the 7th, `addfe382`, was pushed at 01:49:00 UTC, three minutes after #770’s rebase. #773 was rebuilt 4 times, and its move commit had to be redone because `main` had already moved part of what it moved. #825 was rebased twice in an hour (onto `175d3ef5`, then `238fa0af`). #826 needed two full rechecks for one moving `main` (`fdea9398` → `a4bc5836`), then a third base (`8f9c25cb`). Each meant another gate, browser runs and UAT. **host 2.3, deliv 1.4, deliv 4.4, cards 3.2, trans 2.4**
- Merge order caused waits: #770 conflicted once #760 merged, and its sign-off had to be withdrawn. #777 conflicted with #775’s `openBigRoom`. #783’s PF-1 had to be rerun after #777’s round 3. **crit 3.3, meas 3.4, deliv 2.3, host 3.3**
- A retarget to `main` doesn’t start CodeQL, and a close and reopen didn’t either (#783 still lists 17 checks). **crit 2.4, host 5.5, deliv 3.4** *(deliv 3.4 and 6.3 assumed the reopen worked; lead-delivery corrected that in the room after the reveal.)*
- **Action (adopted, 4):** stack at most one deep; rebase once, right before the final gate; and find what starts CodeQL on a retargeted PR. **host 6.2, trans 6.3, crit 6.3, deliv 6.3**

### T5. The send-backs shared one shape (7 of 7)
- **A writer, reader or caller of a changed value wasn’t grepped again.** #760’s `store-outage.mjs` passed `by: 'you'`. #770’s `installed` was read by the card and by the trigger. #776’s `heldFor` read held, uncommitted state into a prompt, through a helper that `store-held-guard.test.mjs` couldn’t see. #781 introduced a name `main` already had. **cards 4.2, cards 4.3, crit 4.2, crit 4.3, crit 4.4, host 4.3, deliv 4.1**
- **A design claim wasn’t read against the code it depends on.** #781’s note proposed an id tiebreak, but `newId` is random. #780’s security note got the Lines view wrong, and never read the host tool routes; the live UAT found the silent refusal (#827). **deliv 4.2, res 4.1**
- **A failure case had no test.** #755’s consent write raced the rule. #770 had no case for the host being fixed by someone else. #760 had no case for a stop that wasn’t the person’s. #758 had no #88 spec under `POSTBOX_STREAM_LAG=300` at a narrow width, so the dropped box-size check in `heard()` went back out. **host 4.1, host 4.2, cards 4.1, crit 4.4, trans 4.2**
- **The test checked that the old outcome was gone, not what the new one is:** #770’s card. #808’s first fix had the same flaw (`reinstalled`) and was dropped before it reached the person. **host 4.3**
- **An instrument was never proved.** #777’s observer recorded nothing and still passed PF-1 (`d1644da0`). #564-b1’s first spec counted only `querySelector`, so the branch’s own `getElementsByClassName` passed it. It was fixed with one shared list, `SCANS` (`1559c481` red, `fe4f7314` fix). **meas 4.3, crit 4.1, res 4.3, trans 4.4**
- **Hostile input wasn’t tested.** #825’s alt escape survived its mutant, because every test alt was plain text. **cards 4.4**
- Mutants covered only the new guards, not every condition the fix depended on (#770). **host 4.4**
- **Action (adopted, 5):** test design in the pre-review packet, in parts (a) to (f). **host 6.3, cards 6.2, meas 6.1**

### T6. The build host’s limits and one test host (7 of 7)
- Gates waited on loads of 20 to 76, or started too high (23, 27, 33, 47, 59). A Node 22 timing test failed at 47 and passed at 18. **deliv 3.3, deliv 5.3, host 5.3, trans 1.5, trans 3.5, meas 3.5**
- **/tmp inodes** reached 76% again after #797 was filed, before #802 merged, and needed a second clean-up (s3-buildhost-tmp-clean-2). Gates checked `df -i` first. **res 5.4, deliv 5.3, meas 5.1, trans 5.4**
- **Red CI that wasn’t the code’s fault** still cost a round each: a fixed 40 ms wait in #755’s consent-off test (fixed in `c961ce7c`), a browser shard cancelled at 20 minutes with no log (#770, run 42124671370), and a race in a new spec step (`552b3996`). **crit 5.4, host 3.2**
- One test host for every lead’s UATs meant waits. #760’s UAT waited from 00:29 to 01:14 UTC, and #808’s waited behind `reviewfigures`. **cards 1.5, host 1.3**
- The Mac ran at a load of 23 to 50 all afternoon, so #777’s under-one-frame rule never ran live (#818). **res 1.3**
- **Action:** none adopted on its own. The gate script (T10) waits for the load inside the lock, and rule 5(e) covers a fixed sleep.

### T7. Hand-backs went stale before approval, and each GitHub write ran in series (5 of 7)
- Facts went stale between drafting and posting: s3-777-handback-r2 was asked again, because CI and the Mac run had changed. #780’s “four items done” arrived at a head without the P1 fix. **meas 3.3, crit 1.4**
- Every write went through critic and then the person, so a single added line needed another round trip. S3 rule 6 left #802 and #777 checked and ready, but unsigned, for about 40 minutes. #773’s hand-back was still waiting on the person at the close. **cards 3.3, crit 3.2, deliv 3.2**
- **After approval, it was fast:** posting #777’s hand-back and critic’s sign-off took minutes (comment 6672935087, then 6673079130). The wait sits before the approval, in drafting and re-asking. **meas 3.2**
- Skipping the order is its own failure: researcher twice showed the person new content before critic read it, with the overlap map and #806’s r2. **res 3.4**
- **Action (adopted, 7, its second half):** a hand-back’s facts are refreshed when it’s posted. **meas 6.3**

### T8. Messages and wakes arrive late (4 of 7)
- researcher’s #775 and #777 results waited behind lead-measure’s held wake, and twice reached a lead that had been stopped. **res 1.4, meas 5.2, trans 3.2**
- A message to a busy agent arrives after the work it asks for is done, so replies cross. A message queued for a busy agent in a thread doesn’t show there until it’s delivered (#803). **trans 5.2, res 5.3**
- A host’s queued tool calls fail silently (#827). **cards 5.3**
- **Action:** none adopted. #803 and #827 are filed.

### T9. Citations nobody checked (5 of 7)
- **Commits not on GitHub.** #783’s note gave its after side as `6fd9c743`, a local merge of `99c15ffa` with `74faa16c` that no ref held. The first fix named `99c15ffa` and `74faa16c`, and `99c15ffa` wasn’t on a ref either. Both sides were rerun on `a5d2a0f7` and `2b6d6358`. #826’s full browser run was on an unpushed head, `ba196c81`, and its timings were on heads from before the rebase. **deliv 4.3, meas 4.4, trans 4.3**
- **Hashes and quotes sent unchecked.** lead-cards sent critic a placeholder hash, then hashes from before a rebase, for #825, and corrected both the same turn. researcher’s mods report r1 quoted a line AGENTS.md doesn’t contain, and critic caught it with `grep`. **cards 3.5, res 4.2**
- **Action (adopted, 7):** a script checks that every cited SHA is on a remote ref (Draft B). Grep every quoted line before sending. **deliv 6.1, meas 6.3**

### T10. Hand-rolled gate and sign-off scripts failed quietly (3 of 7)
- critic’s sign-off script posted a label over a `merge-tree` conflict, and before that it didn’t gate on the per-commit result. **crit 1.3**
- One gate exited 69 inside a job that reported 0. A spec list passed as one zsh word ran no tests. A Biome run piped through `grep` hid its exit code. **trans 3.3, deliv 1.2**
- The counterpoint: lead-measure’s gate run reported what it left behind, and that was the evidence #802 needed (see What worked). **meas 1.2**
- **Action (adopted, 3):** one shared gate and sign-off script that waits, prints, and fails loudly (Draft A). **crit 6.2, trans 6.2, deliv 6.2**

### T11. macOS-only defects were found after sign-off (3 of 7)
- #802’s TMPDIR depth, #777’s fast machine (`cb64d995`) and #775’s DevTools viewport each came back from the person, and researcher reproduced them on the Mac only afterwards. #777’s second send-back (`d1644da0`) is an instrument case, under T5. **meas 1.3, meas 4.1, meas 4.2, trans 4.1, res 1.1**
- **Action (adopted, 6, after revision 2 was approved):** a Mac check before sign-off. **meas 6.2, trans 6.3**

## Where the answers differ

- **Close and reopen for CodeQL:** lead-delivery’s action 3 still recommends it, because the file was hashed before the reopen was tried. critic, lead-host-install and lead-delivery’s own message after the reopen show it didn’t work on #783. **deliv 6.3** against **crit 2.4, host 5.5**
- **Subagents:** critic, lead-cards and lead-transcript found them the most useful part of the setup. lead-host-install and lead-measure hardly used them, because their late fixes were small and serial. **crit 1.1, cards 1.1, trans 1.1** against **host 1.4, meas 1.4**
- **Push prompts:** lead-delivery and lead-measure both keep a confirm on each push, for different reasons. lead-delivery: only the second “Allowed” after a confirm is waste. lead-measure: the confirm is right for outward writes, and its cost is one trip to the person per push. critic and lead-cards want a standing allow for their own branches. **deliv 5.5, meas 5.5** against **cards 5.1, crit 6.1**

## Single-source points worth keeping

- **Split a large item before its branch exists.** #780 became a design note, five security parts, a host path, two UATs and 44 commits as one item. **cards 2.4, cards 6.3**
- **Measure before carding.** #564-b1 was carded 8 on its first scope, then 5 after lead-transcript measured. **res 2.2**
- **A question waiting on another agent needs an owner and a deadline.** The allow-list draft waited all sprint on four unanswered questions, and #671-b’s did too. **res 3.2, res 3.3, res 6.3**
- **A draft revised after critic’s read should replace the block before the person can answer it.** The person approved an outdated draft twice (s3-780-corp-issue, s3-showapp-host-issue). **cards 5.5**
- **Start an analysis from `intent.md`, not from the room’s current topic.** The first mods report was framed around permission cards until the person asked for `intent.md` (r2, `reports/mods-vs-postbox-r2.md`). **res 1.5**
- **Sprint 4’s order:** #817 first, then the allow list on top of it; #821a early, so #508 is measured in real use. **res 6.1, res 6.2**
- **“Ready” should mean the integrator’s checklist was run on the exact head.** #777 was “ready” twice before round 3. **meas 2.4**
- **Mutant runs shouldn’t need commits.** One scratch commit with `--no-verify` during #777’s round-3 mutants was reset at once and never pushed (#777 hand-back r3). A harness that edits the working tree and restores from git needs no commit. **meas 4.5**
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
| 23 | Reviews that crossed a newer push | at least 4 | not counted | at least 1 (critic’s read of the lag issue’s r2 crossed r3) **res 3.5** |

## Filed during the sprint

This room’s filings, as the answers and the room record name them: #779, #782, #789, #796, #797, #799, #800, #803, #804, #805, #806, #807, #814, #815, #817, #818, #820, #821, #822, #827, #828. The repository had 70 issues created in the sprint window, from every room (`gh issue list --state all --search "created:2026-11-03T21:15:00Z..2026-11-06T03:09:00Z"`, exit 0).

## Changes from revision 1

- T9’s #783 commit was wrong: the after side was `6fd9c743`, not `99c15ffa` (lead-delivery, lead-measure).
- #825 was rebased twice, not three times (lead-cards).
- T5 now holds 7 of 7: #776, #758, #564-b1’s spec, and a new bullet on design claims (lead-cards, lead-transcript, lead-delivery, researcher, critic).
- T6 now holds 7 of 7, adding /tmp inodes and red CI that wasn’t the code (researcher, critic, lead-host-install).
- T7 now holds 5 of 7, and says the wait came before approval (critic, lead-measure, researcher).
- T9 widened to citations nobody checked, 5 of 7 (lead-cards, researcher).
- T2 has Postbox’s stall stop as the source, and `nohup` as a working half of action 10 (researcher, lead-transcript).
- T3 adds the mods bypass, and stops citing meas 5.5 for the second prompt (researcher, lead-measure).
- Rule 23 drops #770: its head didn’t change, `main` moved under it (critic).
- What worked adds the gate run that counts leftovers, and #825’s UAT (lead-measure, lead-cards); single-source points add five.
