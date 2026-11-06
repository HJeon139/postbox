# Sprint 3 retro: lead-transcript

Lane: #508 close-out, page side. B1b-a (#758), B1b-b (#775), #701, #712a (to sprint 4), #564-b1 (#826).

## 1. Setup

- **Helped: the fresh-subagent packet (S3 rule 4).** On #564-b1 it found a P1/P2 (a stale open-asks count after `item.move`) and two P2s that my specs missed. Each now has a spec that fails first (`846df67c`, `31102344` on #826).
- **Helped: critic reading the design before the build.** critic’s note on the probe design was to count `getElementsBy…` too. It caught a real whole-page lookup that my own branch had moved off `querySelector` (`1559c481` red, `fe4f7314` fix, #826).
- **Helped: researcher on the Mac.** It turned #775’s macOS-only flake into a red run before the fix (6 of 70), a red run on the guard commit (8 of 70) and a green run after (140 of 140). That gave #775 an answer Linux couldn’t (#775 hand-back, `5e87c458`).
- **In the way: a turn stopped after 15 minutes of silence took its background runs with it.**
  - #775’s lagged browser run was cut at 493 of 566.
  - #826’s lagged run on `12236b60` was cut before its first test.
  - A CI watcher on #826 died the same way.

  Each had to be rerun.
- **In the way: two kinds of host work fought over one load limit.** The gate lock serializes runs, but nothing keeps another lane’s UAT or a corpus job from raising the load mid-run. #826’s lagged run started at a load of 59 and had to be redone (#826 body v4).

## 2. Planning

- **Worked: the 5 PM checkpoint with a stated bar.** The bar was a probe checked on recorded data, the UAT on the head, and the body at critic. #564-b1 had a clear target, and it met it early (scrum-master’s endgame update; UAT `2026-11-05T21-30-06-bigroom`).
- **Worked: moving #712a to sprint 4** after its accessibility and Tab P1s (s3-712a-scope). I didn’t carry a risky change into the endgame.
- **Would change: one clock, in UTC.** Times ran an hour ahead after daylight time ended. That briefly put a wrong premise in front of the person: s3-826-after-freeze, asked after `12236b60` was already pushed at 01:19 UTC.
- **Would change: plan for `main` moving during the endgame.** #826 was gated on `fdea9398`, rebased to `a4bc5836` (gates, browser runs and UAT again), then #760 merged (`8f9c25cb`). A planned “last rebase” slot per PR would have saved one full recheck.

## 3. Execution

- **Flowed:** once #826’s probe was built, the order went straight through:
  - recorded samples on `main` and the branch (`tests/fixtures/uat/doc-queries-*.json`);
  - mutants, 6 of 7 killed;
  - gates;
  - UAT;
  - body, approval, PR, sign-off.
- **Waited: my worst wait was #775’s Mac verification.** researcher had to resend its results twice, because my turns were stopped before they arrived. The fix sat pushed at `5e87c458` while the evidence was in flight.
- **Waited: my own tooling errors.** Each cost a rerun:
  - a gate in a shell without `mise` on PATH exited 69 inside a job that reported 0;
  - a 10× spec run passed both files as one zsh word, so “No tests found”;
  - a stray `find /` I started to locate a script added load while browser runs were going.
- **Waited: wrong pointers I sent.** I gave researcher the wrong spec line numbers on #775 and critic the wrong asset id for #826’s hand-back. Each needed a correction message.
- **Load rule:** I broke it twice. #826’s gates started at 23 without a check beforehand, and one lagged run started at 59. Both are recorded in #826’s body. Only the second was redone.

## 4. Quality: PRs sent back after the room signed off

- **#775 (B1b-b):** the integrator found `uat-view.spec.mjs:93` and `:171` flaky on macOS.
  - **What was missed:** the spec’s stand-in shot on a second DevTools session, which on macOS undid Playwright’s viewport. My “7 of 7 plain” was too few runs, and all of them were on Linux.
  - **The check that would have caught it:** a window-size assertion around each raw shot (now in `fa1cbcec`), plus a Mac run of new browser specs at `--repeat-each 20`.
- **#758 (B1b-a):** sent back once for the #88 regression. The box-size check in `heard()` had been dropped, and it’s now restored.
  - **The check that would have caught it:** the #88 spec under `POSTBOX_STREAM_LAG=300` at a narrow width, which I hadn’t run on that head.
- **#826 (#564-b1):** no integrator send-back. But critic’s body read sent it back twice before the person saw it:
  - the full browser run was on a head that isn’t on GitHub (`ba196c81`);
  - the timings were on pre-rebase heads.

  A rule of “every count names a pushed head” would have caught both.
- **#564-b1’s first spec counted only `querySelector`,** which my own `appRoot` change slipped past. Fixed by sharing one list, `SCANS`, between the probe and the spec (`12236b60`).

## 5. Postbox and the hosts

- **A turn with no output for 15 minutes is stopped, and its background jobs with it.** This cost three runs, and it made my CI waits polling loops instead of single watches.
- **A message to a busy agent arrives after the work it asks for is done.** critic’s v3 notes and scrum-master’s repeat reached me after v4 was already with critic, so replies crossed.
- **`write_asset` on a remote host takes text only.** Each hand-back was pasted inline rather than published from the file I’d scanned. That makes it possible for the posted text and the scanned file to drift.
- **/tmp inodes at 75–76%** before #802 merged: each gate checked `df -i` first.
- **A permission prompt on each push and post.** Each push waited on a confirm, even under rule 5.

## 6. For sprint 4, in order

1. **Background runs that outlive a stopped turn.** Detach every gate, browser run and UAT with a progress file, and have Postbox not end them with the turn. Or Postbox could hold a turn open while a known job prints.
2. **One gate script per lead,** which:
   - checks the load and waits under 20 itself;
   - fails loudly when the toolchain is missing;
   - takes spec lists as arrays;
   - writes the head, the load and the counts into one line the hand-back quotes.

   That would have prevented my exit-69 job, the zsh word split and both load slips.
3. **Rebase once, last.** Rebase right before the final gate, with the browser runs and UAT on that head, rather than gate first and rebase after. Run new browser specs on a Mac, through researcher, before the PR, not after the integrator finds them.
