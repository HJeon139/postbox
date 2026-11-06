# Sprint 3 retrospective: lead-delivery

My items: #708 (merged), #694 (merged as #741), A1b's design (#781, merged), #712b (#769, merged), B1b-c (#773, open), and #783 (taken over from lead-measure after the resume, open).

## 1. Setup

- **Helped: critic's reads against the code, not the prose.** On #781, critic's dead-need case (a newer host permission dead after a restart while `waitOn` re-offers an older one) became R8, and it was only visible from reading `server/remote/turns-prompts.mjs`. Evidence: #781 at `bbcb65bc`, R8 in `designs/508/a1b-asks.md`.
- **Helped: the S3 rule that every commit passes Biome on its own.** It caught real gaps in my own runs: my first per-commit run on #781 piped Biome through `grep` and hid its exit code, so I discarded it and reran with each commit's own exit code. Evidence: #781 hand-back r2 (issuecomment-6651742654).
- **Helped: fresh-subagent checks on design notes.** Three of them found three ways #781's earlier tie rule would misbehave (dropping a live permission need, refusing a side-thread app card, breaking the read-order tie). Evidence: #781 body, "Review".
- **Got in the way: stacked branches.** #773 sat on #775, which sat on #758; #783 sat on #777. Each rebase below me forced a rebuild, a regate and a UAT rerun of my branch. #773 was rebuilt four times (`71e95893`, `ddfb5be2`, `0d985123`, `62b0c7b6`).
- **Got in the way: a stale cherry-pick state** left in the #773 worktree from an earlier day blocked `git switch` until I checked its queued commits were already on the branch and ran `git cherry-pick --quit`.

## 2. Planning

- **Worked: the endgame table with explicit freeze times.** It told me exactly when #783 had to be pushed. Evidence: s3-endgame, and #783 pushed at 01:39 UTC, before the 02:00 UTC freeze.
- **Didn't work: times in local time.** Daylight time ended on 1 Nov, and some messages said "PDT", an hour ahead. The build host's own clock said 17:14 PST while another lead's message said 18:14 PDT for the same moment. Change: every time in UTC, as scrum-master then ruled.
- **Didn't work: planning #783's rerun without knowing #777 was about to change the tools under it.** #777's round 3 added a calibration key after my PF-1 passes, so I had to rerun PF-1 a second time. Evidence: #783 addendum at `35a4d2fd` (issuecomment-6674907411).
- **Change:** when a PR is stacked, plan the lower PR's last round before the upper PR's measurements.

## 3. Execution

- **Flowed: the push confirm with a lease and lint first.** Every push of mine went through on the first try after a fetch. Evidence: #773 `62b0c7b6`, #783 `974c9ad4` and `35a4d2fd`, each confirmed by `ls-remote`.
- **Waited: the person's approval of #773's hand-back.** s3-773-handback-r2 was shown after critic's approval and was still open at the close, so #773 is punted with green CI at `62b0c7b6`. That's my worst wait.
- **Waited: the build host's load.** My gates and benches waited inside the gate lock for a load under 20, several times for over 15 minutes. Once I started gates at a load of 47 without waiting, and a Node 22 timing test failed (`remote-broker-prompts.test.mjs:192`); the rerun at 18 passed. Evidence: #781's Verified table.
- **Waited: GitHub's CI after a base change.** #783's retarget to `main` started no CodeQL run, so the PR had to be closed and reopened. Evidence: s3-783-reopen.
- **Lost time: my own silent waits.** A CI watcher that printed only at the end got my turn stopped after 15 minutes of no output. Evidence: the stop at 16:09 PST, and scrum-master's rule after it.

## 4. Quality

- **#781 (A1b's design), sent back at `4c0d1903`:** `store.held` already had a meaning on `main`, a derive over published state couldn't equal `nextNeed`, and a hold record would lose `card.held`'s wakes on a downgrade. Missed check: grep every new name against `main`, and a downgrade row in the failure table before review. Evidence: the integrator's review of #781.
- **#781, again:** the note named an "after" tie rule (an id tiebreak) the code couldn't support, since ids are random. The fresh-subagent checks caught it; reading `newId` first would have.
- **#783, sent back at `4dbf8f51`:** no test that the startup replays the log, and an "after" commit that wasn't on GitHub. My first fix named `99c15ffa` + `74faa16c`, but `99c15ffa` wasn't reachable either; critic caught it. Missed check: `git branch -r --contains <sha>` for every commit a note cites. Evidence: critic's P1, and #783 at `974c9ad4`.
- **#773:** the integrator didn't send it back; critic held it for #775's flake. The rebuild had to redo the move commit, because `main` had already moved part of what it moved. Missed check: none caught it; the conflict did.
- **#773's UAT:** `bigroom.md` phase 1 asked for paging while a reply streams, which the runner can't play. Missed check: reading `tools/uat-run.mjs`'s `settle` before writing a phase goal. Evidence: #805.

## 5. Postbox and the hosts

- **The UAT runner settles every agent before each tester step,** so no run can scroll mid-turn (#805). It made #773's phase 1 goal unreachable in four runs.
- **Turns stopped after 15 minutes without output.** Mine was stopped three times: once for a silent CI watcher, twice for benches or chains whose watchers I hadn't made talk.
- **The build host's load and /tmp.** Gates and benches waited on loads of 20–76 from other leads' runs, and /tmp reached 76% of its inodes before #802 merged.
- **Time zones.** The "PDT" messages after daylight time ended shifted the freeze by an hour for some agents.
- **Permission prompts on every push and gate.** Each push needed a confirm block, then a separate "Allowed" for the command. That's right for pushes, but the second prompt on an already confirmed command added a round trip each time.

## 6. For sprint 4, in order

1. **Cite only reachable commits, and check it:** a lint that runs `git branch -r --contains` (or `gh api …/commits/<sha>`) on every hash a design note or PR body names.
2. **Make every long wait talk:** a shared helper for gates, benches and CI watches that prints a line each minute and checks the load inside the lock, so no turn is stopped for silence.
3. **Fewer stacks:** retarget a stacked PR to `main` as soon as its base merges, and close and reopen it then, so CodeQL runs without anyone remembering to.
