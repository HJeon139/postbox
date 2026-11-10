# Blind retrospective, sprint 4: lead-sweep

Written 2026-11-10 (UTC) before opening anyone else’s retrospective. Format: sprint 1’s `retro/PROMPT.md`, read as sprint 4. Scope: the close sweep, the Linux repro sweep and the fixes I carried.

## 1. Room setup

- **One lead for the no-code sweep, on its own host, helped.** It kept re-checks off the build hosts’ gate slots. Evidence: the pilot of 15 ran on a pinned `main` in its own worktrees, with no GitHub writes (pilot r1: 9 close, 1 after a follow-up, 5 stay open; 14 of the 15 were later closed or kept as drafted, e.g. #14, #85, #216 closed 2026-11-06T08:39Z).
- **A 4-core host with Node 22 only meant queueing every gate.** I ran one spec file at a time and kept a lock for the browser runs. Evidence: this turn’s 14 node specs ran one file at a time (82 pass) and one Playwright file at 2 workers (13 pass). The full two-Node gate never ran here, as the brief asked.
- **Moving to Kiro on this host worked on the first turn.** git, gh 2.103.3, Node 22.23.4 and Playwright all ran. Evidence: this turn’s `git fetch origin main` exit 0, `gh pr list` exit 0 (165 PRs) and the browser spec exit 0, after the Claude Code 403 forced the switch (plan block sprint4-close-plan, revision 6).
- **Two tool limits cost time.** Kiro’s permission rules refuse any shell command with a newline, so every multi-line check had to become a script file. `write_asset` refuses a `path` on a remote host and takes only text. Evidence: this turn’s refused inline `node -e` and the `write_asset` error “On a remote host, write_asset takes text”. scrum-master hit the same newline rule (its note “Multi-line commands are refused”).
- **A shared GitHub account hides who owns a PR.** `gh pr list --author @me` returned all 24 open PRs, so my state at close had to come from my worktrees’ branches. Evidence: this turn’s `gh pr list --state open --author @me` (exit 0, 24 rows), against the 3 open PRs that map to my branches (#1178, #1183, #1211).

## 2. Grooming, estimation and planning

- **The triage verdicts needed re-checking.** Triage was wrong or incomplete on 6 of the pilot’s 15. Evidence: pilot r1’s table. #203, #411 and #483 were triaged “fixed” but are only partly done and still open; #416 and #446 were “stale” but still held.
- **“A PR says Fixes” wasn’t enough, and neither is “Refs”.** All 25 issues in the close set were named only with `Refs` or `Part of`, and 24 of the 25 still have work left. Evidence: this turn’s scan of the 165 merged PRs, and `retro-sprint4/close-sweep.md` (1 close candidate, 18 partly done, 6 stay open).
- **Slicing big issues into PRs that each say Refs leaves the issue as the only record of what’s left.** That worked when the owner posted a “Partly done … still open” comment (#975, #994, #1007, #1032 and #1072, all 2026-11-09T21:49Z), and failed where nobody did (#623, which has no comment, and #354’s datasets reader, unmentioned since #825).
- **I’d estimate the repro sweep by issue, not as one block.** #519 took a design, a fix and a PR, where #843 and #464 closed through other leads’ work. Evidence: #1186 merged 2026-11-10T17:01Z for #519; #843 closed 2026-11-07T19:49Z; #464 closed 2026-11-06T17:49Z.

## 3. Execution

- **Small fixes flowed.** Fifteen PRs from my branches merged this sprint. Evidence: #929, #943, #946, #1002, #1009, #1022, #1034, #1057, #1063, #1065, #1071, #1098, #1101, #1114 and #1186.
- **Work waited at the person’s review queue, not at CI.** Evidence: #1178 and #1183 have been labeled approved since before the close, with CI still running at the close; #1211 is REVIEW_REQUIRED. The plan names six PRs over rule 17’s limit of 4 (plan block sprint4-close-plan).
- **The pin moved under the sweep.** `main` went from `67f050e1` to `496d938e` at fetch, and #1075 merged 21 minutes before the pin, which changes #508’s and #712’s rows. Evidence: this turn’s `git fetch` output, and #1075 merged 2026-11-10T17:30:19Z.
- **A zero count was a naming problem twice this turn, not a finding.** A grep for `anchorId` (#531) found 0 because the field is `anchor`. A content grep for `control-` scenarios (#983) found 0 because the word is in the file names. Evidence: `retro-sprint4/close-sweep.md`, rows #531 and #983.
- **One local commit was left behind a force-push.** `fix/1161-claude-mcp-down` has a local commit `4662feb3` and 3 modified files that aren’t on the remote head `121fab21` (`git cherry` shows it as `+`). Evidence: this turn’s state check.

## 4. Postbox itself

- **An agent’s Postbox tools can fail to load with nothing shown.** That was the root of #489, now partly fixed for Kiro (#1158), with Claude Code and Codex in #1178 and #1183. Evidence: #489’s 10 November comments.
- **`write_asset` can’t publish a file from a remote host.** A 20 KB sweep table had to be pasted as text. Evidence: this turn’s refused `write_asset { path }`.
- **The room’s agent descriptions were out of date** (“Claude Code, Opus 5.5, high effort” on agents now on Kiro or Codex), and the persona model box takes names Kiro doesn’t list. Evidence: scrum-master’s persona-config table and its model-name note in this room.
- **A run’s report reads only Claude Code’s transcripts,** so a Kiro or Codex agent’s refused GitHub call isn’t counted. Evidence: `tools/uat/github-attempts.mjs`’s header on `496d938e`, #1072.

## 5. For the next sprint, in order

1. **Every PR that slices an issue posts the issue’s “still open” list when it merges, or says `Fixes`.** That makes the close sweep a check, not a hunt. Evidence: #623 and #354 had no such list; #975, #994 and #1007 did.
2. **Merge or defer the approved PRs before opening new ones,** starting with #1178 and #1183, which finish #489’s other backends. Evidence: both approved, with CI in progress at the close.
3. **Run #983’s six scenarios once,** so #983 can close and #995 and #997 have the run their acceptance needs. Evidence: `retro-sprint4/close-sweep.md`, rows #983, #995 and #997.
