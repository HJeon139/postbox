# Sprint 4 retrospective: the aggregate

Twelve blind files, each written before its author opened any other: critic, lead-cards, lead-delivery, lead-host-install, lead-measure, lead-security, lead-state, lead-sweep, lead-transcript, researcher, scrum-master and tester. I wrote mine (`scrum-master.md`) before reading the other eleven. A theme counts an agent when its file raises the theme with evidence; the counts are mine, from reading all twelve.

The facts behind it are in `state-at-close.md` and critic's `pr-check.json`.

## The sprint in one paragraph

167 PRs merged between 6 November, 07:40 UTC and the close on 10 November. Building outran merging: at the close, 11 PRs were labeled ready for the person against rule 17's limit of 4, and no PR merged between 09:40 and about 17:00 on the last day. The sprint ended early, when the Claude Code usage block (a 403) and two Postbox out-of-memory crashes (#1210, #1213) stopped almost every agent at once. Nine agents moved to Kiro or Codex, and the close ran in one turn each, two at a time, with no failed turn.

## Themes

| # | Theme | Agents | Count |
|---|---|---|---|
| 1 | The person's merge queue, not building, set the pace | scrum-master, lead-transcript, lead-state, lead-security, lead-sweep, lead-host-install, lead-cards, lead-measure, lead-delivery, critic | 10 |
| 2 | One shared GitHub identity hid who owns and who pushed | scrum-master, lead-sweep, lead-host-install, lead-transcript, lead-state, lead-security, lead-measure, tester | 8 |
| 3 | One backend, and turns or subagents that die, stopped work and left it half done | scrum-master, lead-security, lead-state, lead-transcript, lead-cards, lead-delivery, tester, researcher | 8 |
| 4 | Postbox defects the room hit | all 12 | 12 |
| 5 | A label or a check stops being true when the head moves | critic, researcher, lead-host-install, lead-cards, scrum-master, tester | 6 |
| 6 | Items too big for one review, and slices that leave a tail | lead-sweep, lead-cards, lead-delivery, lead-measure, lead-host-install, scrum-master | 6 |
| 7 | A measurement without a checked control misled | lead-transcript, tester, researcher, lead-state, lead-measure | 5 |
| 8 | Defects that only show beyond the change's own case | lead-state, lead-security, lead-delivery, critic | 4 |
| 9 | The Mac is a shared resource, scheduled by chat | researcher, tester, lead-transcript, lead-security | 4 |

### 1. The merge queue set the pace (10 of 12)

- **The count:** 11 ready at the close against a limit of 4; 16 to 19 labeled at the 13:45 and 15:46 stand-ups (lead-transcript, lead-security); #1133 labeled from about 06:10 and merged at 16:58 (lead-state).
- **The cost of waiting:** #1182 and #1165 went back to “changes requested” after hours in the queue (lead-state). #1199 to #1201 sat gated and idle for about two hours under a pause on new PRs (lead-security).
- **Stacks and size made it worse:** #1177 (25 commits) and #1198 on top of it are both still open, while single-topic PRs such as #1145 merged in 50 minutes (lead-host-install).
- **Rule 17 had no check that blocks.** It was planned for, then lifted, and nothing replaced it (lead-transcript, scrum-master).

### 2. One shared GitHub identity (8 of 12)

- `gh pr list --author @me` returns every open PR to every agent, so ownership came from local branch names (lead-sweep, tester, lead-host-install).
- The person's fixes on five PRs after the pause looked like an agent breaking it. Only a fetch before pushing kept lead-state and lead-security from pushing over them, and settling it took a question to the person (lead-state, lead-security, scrum-master).

### 3. One backend, and turns that die (8 of 12)

- Nearly every agent was on Claude Code, so one usage block stopped the room on the Mac and both hosts at once (scrum-master, researcher, lead-transcript).
- **Dead turns and subagents leave work behind with no sign:** four of lead-security's subagents died on the 403, leaving uncommitted fixes in three worktrees; tester's #1211 Firefox run never reported; two of tester's turns ended as empty messages; #305's read side stopped where a delegated job ended (lead-security, tester, lead-delivery).
- Ten agents posting the full 403 text buried the messages that mattered (lead-state, lead-security).

### 4. Postbox defects the room hit (12 of 12)

| Defect | Raised by | Issue |
|---|---|---|
| Out of memory twice; the restart pruned the log the crash check needed | lead-security, lead-state, lead-transcript, researcher, scrum-master | #1210, #1213 |
| `/api/state` can't be built past about 100,000 items; a one-value snapshot blocks the server | lead-transcript, lead-state | #1155, #1180 (#1194 open) |
| Room descriptions don't follow the persona's settings | scrum-master, lead-measure, lead-host-install, lead-sweep | to file |
| The persona's model field takes a name the backend doesn't list | scrum-master, lead-sweep, researcher | to file |
| A dead turn leaves an empty message, and a claim it held never ends | tester, researcher | to file |
| Scheduled wakes outlive a plan change, and a wake's note gets cut off | lead-host-install, lead-sweep | to file |
| A progress step for another agent's work shows as stalled when my turn ends | scrum-master | to file |
| A reply without an @-mention doesn't wake the conductor; an @-mention inside `wake_agent` wakes no one | scrum-master, lead-security, lead-delivery | #634 is adjacent |
| `read_conversation` pages are too big to read back; items are cut at 2,000 characters | tester, researcher, lead-transcript, lead-security | to file |
| `write_asset` takes no file from a remote host; Kiro refuses multi-line shell commands | lead-sweep, lead-host-install, scrum-master | Kiro's is a setup rule, not Postbox's |
| Card lifecycle had no single rule: needs lost, expired or kept after decline | lead-cards | #366, #721, #693, all fixed |

### 5. A label or a check stops being true when the head moves (6 of 12)

- At the close, #1181 and #1177 were labeled integrator approved while one failed CI and one conflicted. #1198 was “mergeable” with no checks at all (critic).
- Researcher's #1175 pass was on `1f6e2e3f`, and the PR moved to `7f443c79`. Every #1185 budget sample is on an old head (researcher, lead-host-install). #1159's remote and local heads diverged after critic's check (lead-cards).
- Nine PRs had a new head or state between critic's snapshot and the end of the close (scrum-master).

### 6. Items too big for one review (6 of 12)

- #852 grew to 40 unpublished commits and never became a PR before its issue closed (lead-cards). #305 step 3 merged its write side while the read side stayed on a branch (lead-delivery). #1185 grew to 22 commits and failing CI (lead-measure).
- Of the 25 open issues that sprint 4's PRs name, all are named with `Refs` or `Part of`, and only #983 is near done. Slices worked where the owner posted the issue's “still open” list (#975, #994, #1007), and failed where nobody did (#623, #354) (lead-sweep).

### 7. A measurement without a checked control (5 of 12)

- A feasibility probe that measured the wrong thing was posted on #1155 and then retracted (lead-transcript).
- #1075's “slower start-up” came from a control on an older `main` and nearly held the PR (tester, lead-transcript).
- Two budget rows were void in every browser, from a broken probe (tester). #1185's pass bar moved while samples were being taken (researcher).
- C5's cost was measured after the recommendation, and changed twice in front of the person (lead-state).

### 8. Defects beyond the change's own case (4 of 12)

- **The integrator requested changes on 4 of lead-security's 5 critic-passed PRs,** each for something the tests couldn't see: macOS's temp folder (#1188), Linux's argument limit on every platform (#1190), one failed agent blocking a message to several (#1169), and keys starting with a digit (#1184).
- **The integrator found three more in lead-state's work after critic passed it:** a trimmed `readlink` target and an exponential link walk (#1182), and an agent moved off a silent host (#1165).
- **A realistic fixture still encoded the wrong outcome** (#1023, lead-delivery).

### 9. The Mac, scheduled by chat (4 of 12)

- A claim posted in chat arrives late, so two timed runs overlapped and a sample was marked loaded (researcher). A claim never lapses when its holder's turn dies (tester).
- Firefox findings depend on the Mac being free, since CI runs browser specs only in Chromium (#670; tester).

## What worked

- **Owning an area end to end:** #464 shipped as four reviewable steps (lead-host-install); #633, #760 and #776 shared one needs rule (lead-cards); #508's independent actions merged separately (lead-measure); #817 merged on day one, and all 11 bundle issues closed (lead-security).
- **Independent reads found real defects:** critic's U+2028 and truncated-file findings on #1194 (lead-state); researcher's #1191 check uncovering #1196 and #1197.
- **Agents corrected their own claims with evidence:** lead-host-install on #464, tester on #1075, lead-sweep on a red test, researcher on the Firefox profile, lead-transcript on #1155.
- **The close:** one turn per agent, two at a time, with no failed turn and nothing posted without approval.

## Actions for sprint 5, ranked

Ranked by how many agents named the cause, then by how much each costs the person. Each says how sprint 5's retrospective would check it.

1. **Hold new code PRs while more than 4 wait on the person, and show the count on the board.** Named first by lead-transcript, lead-cards and scrum-master; lead-sweep's second. **Measure:** the most PRs waiting on the person at once; sprint 4: 19.
2. **A label means a verified state:** current-head CI, mergeability and review state together. A push after an outside check re-requests that check in the same message. Critic's first, researcher's second, lead-host-install's third. **Measure:** labeled PRs whose current head has red or missing CI at the close; sprint 4: at least 5 (#1177, #1181, #1184, #1188, #1165, per critic).
3. **Give each agent its own identity on GitHub, or failing that a branch prefix, and fetch and compare before every push.** lead-state's third and scrum-master's second. **Measure:** pushes the room couldn't attribute; sprint 4: 7 commits on 5 PRs.
4. **Keep each PR single-topic and under about 10 commits; a PR that slices an issue posts the issue's “still open” list when it merges.** lead-host-install's second, lead-sweep's first, lead-cards' second. **Measure:** open issues a sprint's PRs name that have no “still open” comment; sprint 4: at least 2 of 25 (#623, #354).
5. **Make work survive a dead turn:** a subagent commits after each step; a claim lapses when its holder's turn ends; a failed turn says so instead of posting empty. lead-security's third and tester's second, with tester's and researcher's Postbox findings. **Measure:** work found only on a host at the close; sprint 4: uncommitted fixes in at least 3 worktrees.
6. **Run a control that fails on a known-broken probe, and agree the method, before a measurement is posted.** lead-transcript's second, tester's third, researcher's third, lead-state's second. **Measure:** measurements retracted or voided; sprint 4: at least 4.
7. **Put hostile inputs and state changes in every failure table before critic reads it:** fan-out, moving agents, text the kernel returns. lead-state's first and lead-security's second. **Measure:** integrator change requests on critic-passed PRs; sprint 4: at least 7 defects across #1165, #1169, #1182, #1184, #1188 and #1190.
8. **One lock for timed Mac runs, in place of chat claims.** researcher's first. **Measure:** timed samples marked loaded; sprint 4: at least 2.

**Not adopted:** lead-security's first action, a required Mac check for server changes that touch paths, temp folders or OS limits. The person chose not to make it a rule (block sprint4-close-decisions). Action 2's re-requested checks still cover it when a lead asks for one.

## To file, as drafts for the person

The Postbox defects in theme 4 marked “to file”. They'll be drafted as issues for the person's review, without duplicating what's open.

## Limits

- **The counts are my reading** of twelve files written for different scopes. An agent that didn't mention a theme may still have hit it.
- **The measures' sprint 4 figures** come from the files and the state at close, and most are lower bounds.
- **Three leads ran on Claude Code for their close turn.** That their turns worked doesn't show the block is lifted for a full room.
