# Sprint 3 retrospective: lead-cards

Scope: #633 (merged), #721 as #760 (merged), #693 as #776 (merged), then #780 as #825 (open at close, changes requested). Times are UTC.

## 1. Setup

- **Helped: subagents for parallel parts, each in its own worktree.** On #780 the host path (base64 bounded before decoding) and the UAT trigger and scenario ran beside my own route and page work; I reran each subagent's key claim and a mutant before taking its commits (the decode-first mutant on `tests/remote-turns-review-files.test.mjs`; the one-figure mutant on `tests/review-figures-trigger.test.mjs`).
- **Helped: a fresh-subagent pre-review packet before critic.** At `8449f909` it found orphaned blobs (about 200 MiB after 10 refused calls) and three surviving mutants, fixed in `d80c9e55`/`3e586ffe` before critic saw the PR.
- **Helped: critic's security reads as a second, independent pass.** Its second read found a real P1 data loss in my staged-blob cleanup (a plain put in flight lost to a refused review's unlink), fixed in `a74989ce`; I had written the concurrency specs and still missed that ordering.
- **Got in the way: every git and gh call needing a permission card.** Each push, rerun and comment was a card to the person, and several of my turns stalled on them, which the person raised in the room as delays from git commands needing Postbox permissions on every tool call.
- **Got in the way: the shared gate lock and one test host for UATs.** My #760 UAT rerun waited behind another lead's two host UATs from 00:29 to past the freeze (`760-rebase-hostexpiry` waited, then ran at 01:14 as `2026-11-06T01-14-26-hostexpiry`).

## 2. Planning

- **Worked: the endgame table and checkpoints.** The 4 PM checkpoint for #780 gave me a hard target (critic's P1 fix by 3:45), and it was met: `4d19d373` pushed at 21:31, critic approved at the checkpoint.
- **Worked: the freeze rule's carve-out for checks on pushed heads.** It let #760's UAT rerun after 02:00 without new work starting.
- **Would change: one clock.** Several of us wrote "PDT" after daylight time ended on 1 Nov; I reported #780's push at 01:13 as after the freeze when it was 47 minutes before, and the room briefly acted on that (scrum-master's correction, 01:16). Times in UTC only.
- **Would change: size #780 honestly up front.** It was one item, but it became a design note, five security parts, a host path, two UAT runs and 44 commits. It should have been split (files and route; host path; UAT) so each half could land.

## 3. Execution

- **Flowed: red spec, then fix, then mutants, then gate, commit by commit.** Each #780 guard has a mutant that fails a spec, and the PR body lists them; the integrator's own review wrote 36 mutants and 32 failed.
- **Waited: on `main` moving under a gating head.** #825 needed three rebases in an hour (29 commits, then 17) as merges landed while my gates ran; each rebase meant gates, browser specs and a UAT again.
- **Waited: on critic's queue and on the person's approvals, in series.** Each GitHub write went critic, then person, then post; on #825 a single added line needed another round trip (s3-780-handback-line).
- **Worst wait: #760, open 18:29 on 4 Nov to merged 01:16 on 6 Nov (30.8 h).** It waited on two integrator rounds (the `stoppedBy` class, then `store-outage.mjs`), then on a rebase after #755 and #775 conflicted, then on the test host for its UAT rerun.
- **Slips of my own:** a placeholder hash and pre-rebase hashes sent to critic (corrected the same turn); a `pkill` that matched its own shell and left a mutant in `blobs.mjs`, restored from the backup before any commit; a gate started at load 23 without my load check (said so in #760's addendum).

## 4. Quality: what the integrator sent back

- **#760, round 1 (`stoppedBy` for every stop):** a shutdown, a hang and a store outage were marked as the person's Stop, so no expiry note went out. Missed because my specs only stopped turns by hand. A class table of every stop reason, with a spec per row, would have caught it; I added that table afterwards.
- **#760, round 2 (`store-outage.mjs` passed `by: 'you'`):** the same class, one caller I hadn't regrepped. The check that catches it is a grep of every caller of the changed function, rerun after each fix, in the packet.
- **#776 (`heldFor` read pending state into a prompt):** a held-store rule I didn't apply to a new reader. `store-held-guard.test.mjs` places every read, but this one went through a helper the guard couldn't see; an adversarial probe with a held commit, as the reviewer wrote, would have caught it.
- **#825 (alt text escape on the attached-image branch untested):** every test alt was plain ("Today", "Trend"), so the mutant removing `escapeHtml` survived. A rule I didn't follow: each new place agent text becomes HTML gets a hostile-input spec (`"`, `<`, `&`) and its mutant.
- **#825's UAT itself caught a defect before review:** run `2026-11-05T21-52-48-reviewfigures` showed a host refusal never reaching the agent; fixed in `b82e930b`, and the class is filed as #827.

## 5. Postbox and the hosts

- **Permission cards on every git and gh call** slowed every push, rerun and comment; a standing allow for my own sprint branches would have removed most of them.
- **Turns stopped after 15 minutes without output.** One of mine was stopped mid-wait on CI; polling loops that print every two minutes fixed it.
- **A host's queued tool calls fail silently.** Found live on #780, filed as #827 with six paths; it would also explain other agents' "I sent it" with nothing shown.
- **The time zone,** as in 2.
- **A refused block update** arrived while the person's answer was still unread (s3-780-corp-issue, s3-showapp-host-issue), so the person approved an outdated draft twice and I asked again; a draft revised after critic should replace the block before the person can answer it.

## 6. For sprint 4, in order

1. **Finish #825:** the alt-escape spec and its mutant from the integrator's review, then #828's points, then merge before more of `main` moves under it.
2. **Make hostile-input specs a rule in the packet:** every new path from agent text to HTML, a header or a file name gets a spec with `"`, `<`, `&` and a NUL, plus its mutant, before critic.
3. **Split large items before a branch exists,** so each piece can land within a day; and post every time in UTC only.
