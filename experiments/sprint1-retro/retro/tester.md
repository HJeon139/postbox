# Tester’s retrospective, sprint 1 (27–29 October 2026)

Written blind: I haven’t read the other agents’ files or retro posts.

## 1. Room setup

- **Rule 9, which splits the testing, helped most.** Authors run the gate and the browser specs, and I do the red runs, stress runs and UAT. That kept my runs on what each change claims. Examples: #485’s lost-link mutation (`2acecf0`, then the test in `451cb63`), and each of #522’s three fixes turning exactly its own test green (`d1811486` → `1388c8b` → `fe39aa6` → `cb6dca1`).
- **The locks (`.scratch/grooming/with-lock.sh`) worked.** I ran the full `POSTBOX_STREAM_LAG=300` suite under the browser lock at a load average of about 55: 432 of 432 on #492 at `7c41687`. Developer saw 17 failures at a load of about 155 (it_TIRic5Gp).
- **The $100 pre-approved test budget removed a blocking ask.** Real-agent runs cost $0.13 to $0.58 each: #504’s thread-focus runs at `823d595`, and #492’s `longchain` runs at `7c41687` and `6d9e012`. Before the person approved it, I was asking per run.
- **What got in the way: wake cards held hand-offs to me.** Developer had to resend #451’s request twice. claude-ssh’s request for `451cb63..47aa466` never reached me, and only surfaced once I was asked for the whole range `451cb63..0c1f626`.
- **The person refused my cleanup of the `wt/tester-522` worktree.** That was right, since it was a `git rm` I hadn’t asked about. But two staged files from `main` stayed in that worktree, so I started a fresh one, `wt/tester-522b`. One worktree per head from the start would avoid this.

## 2. Backlog grooming, estimation and planning

- **The experiment plan with fixed decision rules (`.scratch/experiments/plan.md`, revision 8) held up.** E2’s result went against my own first reading, and the rule fixed in advance decided it. That result reached #492, and the person chose a different direction from it (it_TIRic5Gp).
- **E2 needed 8 plan revisions and several modeling fixes from critic.** The fixes: oracle labels used for the content rule, no reset on NEW, and every wake held while a card was open (`.scratch/experiments/plan-r3.md` … `plan-r7.md`). Writing the replay’s model before the decision rule cost rounds.
- **E4 was promised three times before I ran it** (`.scratch/experiments/e4-replay.py`, revision 2, sha256 `6abc25a2…`). I said “next” without a time, and that let it slip. A planned item for me needs a time, or a hand-off.
- **E1, E3, E5 and E6 didn’t run this sprint.** E6 waits on UAT scenario runs that never came. E1, about $35, is still to be pinned to #499’s final heads. These items were planned with no owner’s time behind them.

## 3. Execution

- **Red runs often needed a mutation or stub.** The new test imported an export the old code lacked:
  - #492’s first red run failed on an import of `PAIR_LIMIT` until I put it back;
  - #466’s red run left the new `server/scheduled-wakes.mjs` in place, so 3 of its 6 tests weren’t really red.

  Saying which kind of red run each was kept the claims honest.
- **Mutation runs found test gaps the authors’ red runs didn’t:**
  - #485’s lost-link condition, where taking it out left all 395 tests passing (`2acecf0`);
  - #511’s `'system'` label, under which the check accepted a lost task context (`b8c010e`);
  - #492’s queued-wake guard, whose removal leaves 225 tests passing (`6d9e012`).
- **I missed a non-move in #513’s move commit.** My check compared lines in only one direction, so it missed the new `clip` without `.replace(/\s+/g, ' ').trim()` (`cd13330`). The integrator found it, and I compared both directions on `f2a306b`.
- **I missed #478’s mapper P1** at `d5da582`, which critic found. My runs never streamed more than one piece.
- **Earlier, I blamed a regression on #495 that was the test’s own setup.** I had compared test bodies that differed between commits; kiro-ssh-x86 caught it.
- **Waiting:**
  - Most waits were on the person’s GitHub review, or on a card blocking every agent’s messages. #513, #536 and #522 waited about 7 hours on one card (researcher’s check-ins from 08:33 to 15:18 UTC).
  - My own results were often posted more than once. A head moved while I ran, or two requests for the same range crossed, as with #451 at `77c6e55` and #511 at `f7e5959`.

## 4. Postbox itself

- **Wake cards blocked unrelated hand-offs.** A card waiting on the person refused or held wakes from other agents, which led to #439 and #492. #492 at `6d9e012` now has no pair limit, a backstop of 50, and a count that starts again when a chain ends.
- **UAT runs for #492 saved no screenshots.** `shots/` was empty in both `longchain` runs, so the tester agent couldn’t see the composer and reported “hint line not seen” twice. I checked the line by serving a copy of the run’s data and opening it with Playwright. This needs an issue.
- **Agents redo stale work after their task ends.** In both `longchain` runs, 14 items took 18 to 23 wakes: agents restated items already posted, and kept going after “Done”. This is the same symptom as the 7-of-218 stale replies on #504 (comment 6488381303).
- **Turn summaries cut whole items.** E4 found that 3.9% of this room’s summaries left out a mention that never reached the agent another way. #484 and #499 changed that, but E1 hasn’t measured the change.
- **Background agents and turns end when the turn ends.** I had to wait on UAT runs inside the turn (Monitor plus an `until` loop), or the result would land with no turn to report it.

## 5. For the next sprint, in order

1. **One worktree per head, and a two-way check of moved code.**
   - Compare lines added and lines removed, for every move commit.
   - Run a mutation of each new guard alongside the author’s red run.
   - Evidence: #513 `cd13330`, #492 `6d9e012`.
2. **A time and an owner on every experiment and UAT item.** Run them, or drop them by the planned time: E1, E3, E5 and E6 never ran, and E4 slipped three times (`.scratch/experiments/plan.md`).
3. **Fix the UAT runner’s empty `shots/`, and add `longchain` as a scenario,** so a run’s tester can judge on-screen claims such as #492’s count line. Today my `longchain.md` is only in my worktree (`wt/tester-492`), not committed.
