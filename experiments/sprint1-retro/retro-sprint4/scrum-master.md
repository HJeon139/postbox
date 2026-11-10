# Blind retrospective, sprint 4: scrum-master

Written before I opened any other agent's retrospective asset. My evidence is this room, GitHub and the close's own records. I joined the close on Kiro after Claude Code's 403, so my view of the sprint's middle comes from the record, not from being in it.

## 1. Room setup

- **Twelve agents on one GitHub account blurred ownership.** `gh pr list --author @me` returned all 24 open PRs to every agent, so each one had to work out its own from local branches (lead-sweep's close reply; lead-cards and lead-security did the same).
- **One backend failing took the whole room down.** The Claude Code 403 (it_3ugcbEPI) stopped almost every agent at once, because nearly all of them ran on it. The person moved 9 of 12 to Kiro or Codex within the hour (the persona table, block sprint4-persona-configs), and the close then ran without a single failed turn.
- **Five room descriptions went stale as soon as backends changed.** They still say “Claude Code, Opus 5.5, high effort”, while the settings say otherwise (block sprint4-persona-configs). Nobody can trust a roster that lags its settings.
- **The Kiro shell refuses multi-line commands,** so lead-sweep and I wrote small script files for any multi-line check (lead-sweep's close reply; my own refused `node -e` this turn). It works, but it costs a step each time.
- **A model name Kiro doesn't list was accepted without a warning.** My persona was set to `anthropic-claude-balanced`, and `kiro-cli chat --list-models` (exit 0) doesn't offer it (it_KTBx79f8).

## 2. Backlog grooming, estimation and planning

- **Rule 17 didn't hold.** Its limit is 4 PRs waiting on the person. My first count found 6 (block sprint4-close-plan, revision 2), and the state at close found 11 labeled ready (`retro-sprint4/state-at-close.md` v2).
- **The plan took five revisions to match the person's intent.** I first read “throttled” as “Claude Code is out”, and twice planned around agents that weren't in the room (sprint4-close-plan revisions 2 to 5). Checking the room's members and their persona settings before planning would have saved four rounds.
- **One turn per agent kept the close cheap.** All twelve agents gave their state at close and their retrospective in a single turn each, two at a time, with no 403 (block sprint4-close-queue).
- **Most of the issues the sprint touched were only partly done.** Of the 25 open issues that sprint 4's PRs name, every one is named with `Refs` or `Part of`, and only #983 is close to done (`retro-sprint4/close-sweep.md`). Planning slices rather than whole issues showed up as a long tail.

## 3. Execution

- **Merging, not building, set the pace.** 167 PRs merged in about four and a half days, and 11 more were waiting on the person's review at the close (`gh pr list --state merged …`, exit 0; the state at close).
- **Heads moved under every snapshot.** Between critic's PR check (about 17:40 UTC) and the end of the close, #1159, #1165, #1175, #1177, #1181, #1182, #1184, #1188 and #1190 all had a new head or a new state. That left critic's `pr-check.json` partly stale within the hour.
- **Pushes under the shared account looked like an agent breaking the pause.** Five PRs got commits at 17:45 to 17:50 UTC, after the pause, and neither owning lead had pushed them. They turned out to be the person's (block sprint4-post-pause-commits), but finding that out took a question to the person.
- **Checks went stale before merge.** Researcher's passing check of #1175 was on `1f6e2e3f`, and the PR has since moved to `7f443c79`. All four of #1185's budget samples are on older heads (researcher's close reply).
- **Agents corrected their own claims.** lead-host-install retracted “not started” for #464-b, tester retracted a start-up slowdown on #1075, and lead-sweep retracted a red test that failed for the wrong reason. Each one followed the rule that a result is checked before it's reported, and each one caught its own mistake late.

## 4. Postbox itself

- **The progress block can't mark a step “woken, working elsewhere”.** A step left running when my turn ended is flagged as stalled, so I marked agents done while they were still working (block sprint4-close-queue). The person saw “done” for work that wasn't.
- **A reply that doesn't @-mention me doesn't wake me.** Critic's finished check didn't wake me, so the queue moved only when the next agent's reply arrived (my 17:52 UTC note).
- **Postbox ran out of memory twice** during the sprint (#1210, #1213). That's part of why the room paused.
- **The tool IDs changed between calls in my session,** so a few block and asset calls were refused until I reloaded them. It cost retries and nothing worse.

## 5. For the next sprint

1. **Hold new code PRs while more than 4 wait on the person,** and make the board show that count. Rule 17 needs a check that blocks, not a guideline (the state at close: 11 ready).
2. **Give each agent its own GitHub identity, or a branch-name prefix,** so ownership and “who pushed this” come from GitHub, not from each agent's local branches.
3. **Before planning, read the room's members and every persona's settings,** and keep room descriptions in step with those settings (block sprint4-persona-configs; sprint4-close-plan revisions 2 to 5).
