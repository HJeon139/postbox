# researcher (scrum master, integrator)

Written before reading any other answer.

## 1. Room setup
- Seven agents across three backends and two remote hosts gave the dev team real parallelism: five fix PRs opened within 13 minutes on 28 Oct (#496, #497, #498, #500 at 16:23–16:28 UTC, `gh pr view --json createdAt`).
- The working agreement grew from 6 to 14 rules (`.scratch/grooming/working-agreement.md`), each from a mistake in the room; rule 9 (who tests what) and rule 13 (the $100 test budget) removed the most waiting.
- Wake cards got in the way most: my hand-offs were refused with “another request is waiting for the person” at every check-in from 08:33 to 15:49 UTC on 29 Oct, while #513 and #536 sat conflicting (room, my check-in posts).
- Role prompts didn’t match the work: kiro-ssh-x86 ran with researcher instructions and gpt with critic instructions while working as developers (`session_start` in their Kiro session records; claude-ssh’s check).
- The computer sleeping ended agents’ turns and delayed my check-ins by up to three hours (tester’s “computer went to sleep” turn; my 04:51 check-in after a 01:53 one).

## 2. Grooming, estimation, planning
- The grooming app (`.scratch/grooming/app.html`, `issues.json`) and urgency board (`board.html`, `notes.json`) let three agents pick 4–8 urgent issues each and the person classify P0s with peer review first.
- My first point estimates had no shared scale; the person asked, and blind planning poker with a defined point and anchors followed (`poker-round2.md`, `estimates-*.json`, `estimates-final.json`). Blindness was weak: agents read the room before their turn, which critic flagged.
- The round plan (`round1.md`) set a 4-hour timebox with marks at +0:15, +1:00, +2:30, +3:30, +4:00; only the claim and failing-test marks held. Everything committed reached a PR about 8 hours after the planned end (burndown in the sprint-board app, version 7).
- Most of the sprint’s work wasn’t estimated: hotfixes and round 2 items (#466 aside) never got points, so the burndown covers 23 of the sprint’s points and none of its hotfixes.

## 3. Execution
- Integration on a local branch (`int/groom-1027`) with the gate run once worked: 7 items merged, 421/421 browser specs both ways (my report 07:50 UTC 28 Oct). Cherry-picking rewritten deltas avoided re-merges.
- Work waited on merges more than on building: seven PRs touched `claude-stream.mjs`, `runtime.mjs` or `designs/intent.md`, and #511, #512, #513 and #536 each needed `main` merged in at least once, with CI not running while they conflicted.
- I missed a “changes requested” review on #522 for 11 hours because I swept comments by time window (room, the person’s question at ~16:40 UTC 29 Oct).
- Relaying gpt’s drafts (#489) worked mechanically but the person ruled it out; the PRs for #504, #486 and #503 were opened by me only after the person chose that path (`gpt-prs` block).

## 4. Postbox
- #439 (held wakes) and then the pair limit blocked hand-offs; #492 removes it with a backstop.
- #484: summaries dropped mentions (E4: 3.9% of this room’s summaries).
- #485: an empty reply hid a report.
- #489: a Kiro session had no Postbox tools all sprint.
- #504: a thread request was buried under room catch-up.
- Long messages arrived cut at 2,000 characters, so agents asked for resends (#499).

## 5. Next sprint, in order
1. Merge plan up front: list shared files per PR and set a merge order, so each branch rebases once.
2. Sweep PR feedback by owner reply on every check-in, and answer any open card before anything else.
3. Estimate every item, hotfixes included, and keep the board and burndown live from the start.
