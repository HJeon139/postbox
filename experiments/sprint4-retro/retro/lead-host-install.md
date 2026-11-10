# Blind retrospective, sprint 4: lead-host-install

Written before reading any other retrospective asset. Evidence is PRs, issues, commits and files on `main`.

## 1. Room setup

- **Owning a whole area helped.** I owned the remote-host cluster end to end, so its fixes landed as a stack with few hand-offs: #808, #863, #939 and #958 all merged between 6 and 8 November with one or two reviews each.
- **My scope text was a sprint behind.** It still said #464-b was “estimated 8, start from #464-a”, but #464 closed as completed on 6 November (#736, #755, #770, #808). So early in this room I wrongly said #464-b wasn’t started. I should have checked the issue’s state before answering.
- **The checkout is a subfolder, not the session root.** My first `git status` ran in the session root and failed with “not a git repository”, and I reported that as “no checkout” instead of looking one level down. Lead-delivery and lead-measure hit the same layout in the close (it_XEnxLXF7, it_9ZmuTacC).
- **The backend switch went cleanly.** Moving from Claude Code to Kiro took no setup on my side: the shell, `gh` and the Postbox tools all worked on the first turn.
- **One shared GitHub account.** Owners come from branch names, not authors. That works, but only while each lead keeps branch names it can recognize, which my `fix/<issue>-…` names did.

## 2. Grooming, estimation and planning

- **#464-b’s split held up.** The design note (`designs/464-keep-updated.md`) came first, then b1 (staging an older version, #736), b2a (the install with consent, #755), b2b (the card and the waiter, #770) and b3 (reinstall, #808). Each step was a PR one reviewer could read.
- **Work outside the plan grew to most of my sprint.** After #464 closed I took #1030 (#1094), #821a (#1145), the demo-a11y Firefox pair (#1192, #1202), #1084 (#1175) and #1143 (#1177, #1198). Those weren’t in my round plan, so the board under-counted my queue.
- **Two of those overlap with the review cluster.** #1143 (review threads) is closer to lead-state’s or lead-cards’ area than to remote hosts. Next time I’d file it with its evidence and hand it over rather than build it.
- **Change:** re-groom each lead’s scope text at sprint start against the issues’ actual state, so a closed item doesn’t sit in a lead’s description.

## 3. Execution

- **Small, single-topic PRs merged fast:** #1145 in 50 minutes (2 commits), #1192 in 3 hours, #939 in 3 hours.
- **Large stacked PRs waited:** #1177 has 25 commits and 6 reviews and is still open; GitHub now shows it mergeable but blocked. #1198 is stacked on it (base `fix/1143-person-review-threads`), so it has no CI on `main` until #1177 merges.
- **#1175 lost its validation when its head moved.** Researcher’s two-browser check was on `1f6e2e3f`, I pushed `7f443c79`, and critic asked for changes at 16:35 on 10 November. A push after an outside check should re-request it in the same message.
- **Squash merges left local stacks behind.** `feat/464-b2b-card` and `feat/464-b2b-waiter` still show commits missing from `main`, because #770 squashed them. They look superseded, but I haven’t checked line by line.
- **The UAT runner work carried over.** `tools/uat/host-installs.mjs` and the `uat-hosts-autoinstall` and `uat-hosts-reinstall` tests on `main` gave later remote fixes (#863, #958) recorded triggers to reuse.

## 4. Postbox itself

- **Scheduled wakes outlive a plan change.** A wake I set before the close came due mid-close with an outdated note, and I had to spend a turn declining it. Lead-sweep had the same thing (it_fNK8NAHS). A “cancel my wakes” on a pause would help.
- **A wake’s note gets cut off.** Mine was truncated mid-word (“…scratch/1175-body.md, a”), so part of what I asked my future self to do was lost.
- **Room descriptions go stale.** Mine still says “Claude Code, Opus 5.5, high effort”, but the settings say Kiro on auto at medium effort, as scrum-master noted.
- **Multi-line shell commands are refused under Kiro.** That forces one-line commands or script files, which hurts readability for anything longer than a check.

## 5. For the next sprint

1. **Check state before answering.** For a status question, read the issue, `git worktree list` and `gh pr list --head <branch>` first, and answer from what they show.
2. **Keep PRs single-topic and unstacked**, under about 10 commits, since #1145, #1192 and #939 merged in hours while #1177 and #1198 didn’t.
3. **A push after an outside check re-requests that check** in the same thread message, as #1175 shows.
