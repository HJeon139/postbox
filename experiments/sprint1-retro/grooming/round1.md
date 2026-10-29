# Round 1 (approved 28 October 2026), started 04:33 UTC, ends 08:33 UTC

Timebox: 4 hours for building and internal review. PRs, CI and the person's GitHub review come afterward, separately.

| Item | Author | Branch / worktree | Validation |
|---|---|---|---|
| #439 a waiting wake card drops other wakes | developer | `fix/439-held-wakes`, `wt/developer-439` | critic, tester |
| #208 each Claude Code and Agent SDK persona remembers only what it learned | claude-ssh (x86 host) | `fix/208-memory-per-persona`, own worktree on its host | critic, tester |
| App-check bugs #37 #327 #328 #336 | kiro-ssh-x86 (x86 host) | rebase `fix/app-check` onto `origin/main` | critic, tester |
| #468 review comment wiped on re-render, with #488 activity list closes | gpt | `fix/468-488-keep-state`, `wt/gpt-468` | critic, tester |

Marks (UTC): claimed by 04:48; branch with a test that fails on main by 05:33; ready for review (pushed, `npm run check` exit 0, both browser runs for a visible change) by 07:03, else cut to the next round; critic and tester approve by 08:03; researcher merges approved branches onto `int/groom-1027` and runs the gate by 08:33.

Authorized by the approved plan: claiming the issue as CONTRIBUTING.md says (assign yourself, one-line comment), and pushing your own branch. Don't open a PR yet: PRs are the separate step after the round. Any other GitHub write needs a draft first (rule 5).

Rules: `.scratch/grooming/working-agreement.md` (1–7) and rule 8 (load): on this computer one full browser run at a time (`mkdir /tmp/postbox-browser.lock`, remove after), at most two `npm run check` at once (`/tmp/postbox-check.lock.1` / `.2`); iterate small, prove once; own worktree, ports and data; rerun a failure under load once alone before calling it flaky; no UAT runs. The x86 host has no locks.

Report each mark in the conversation with the head commit and exit codes, @-mentioning researcher. Remote authors: put everything a reviewer needs in the message, not as a host path.

If you finish early: developer takes #458 and #466 next; anyone else asks researcher for a polish item (#475–#478, #486).
- critic P3 on #468/#488: details.raw ('Show the raw block', app/js/blocks.mjs:127) still closes on update; add to activityKey. Queue for gpt after #486, as its own commit.
- critic P3 on #439 (c5e4bd1): app/js/hop-card.mjs:59 closed card says "so its message went on" even when the hand-off waits on a new card. Developer, as its own commit after tester approves c5e4bd1 (don't move the head under tester's gate). Doesn't hold the merge.
- #477 toggle wording: claude-ssh used chevron + count; choice block 477-toggle asks the person.
