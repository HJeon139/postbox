# Blind retrospective, sprint 4: tester

Written before opening any other retrospective asset. Evidence is a PR, an issue, a commit, a scratch note in `.scratch/tester/`, or a room message id.

## 1. Room setup

- **One shared Mac for timed browser runs worked when claims came first.** I posted a claim before #1211’s Mac check (it_KR7eBkds), and researcher held its own timed runs until I finished (it_fVaXb3bK). That kept my #1075 reference runs and #1151 before-and-after runs to one Playwright run at a time (`.scratch/tester/ref1075.md`, `b1151.md`).
- **The Claude Code 403 cut my turns off mid-check, with nothing posted.** Two of my turns ended empty (it_g4DGibjY, it_z1UDrgEO), and #1211’s Firefox run never reported after “The Chromium run is next” (it_VfK8dsLG). The room had no sign the check had died until the close.
- **A shared GitHub account hides who owns what.** Every PR shows the same author (`gh pr view 1211 --json author`), so ownership has to come from branch names and room messages. I found mine by `git branch -vv` and `gh pr list --head`, not by `--author`.
- **Worktrees outside the repository pile up.** Seven per-PR check worktrees each carry an untracked `pw-firefox.config.mjs` (`git status --porcelain` on each). They are disposable, but nothing in the working agreement says who removes them or when.

## 2. Grooming, estimation and planning

- **Tester work came as requests from leads, not as planned items.** #1211’s check came from lead-sweep (it_60kQSefw); the #1075 and #1159 measurements came from the budget work. None had an estimate, so my load never showed on the board.
- **The million-item target arrived mid-sprint and changed what a “pass” meant.** `docs/508-close-out` needed a second commit, `48626164`, to follow the 10 Nov target (#1155), after `c56cd0be` was written against the old one.
- **Failing-first test PRs need a planned owner for the fix.** #1147 holds #987’s specs for lead-state, who owns the fix (`.scratch/tester/1147-body.md`). It sat as a draft with red CI by design, and the board had no state for “red on purpose”.
- **I’d change:** give tester a small budget of planned check slots per round, so a lead’s request is a scheduled item with a timebox, not an interrupt.

## 3. Execution

- **Measurement changed a verdict twice, in the right direction.** My first #1075 comment said it slowed Firefox start-up. The control runs showed the gap came from the server still busy after seeding 10,000 items, and a 5 s wait removed it on both heads (`.scratch/tester/c1075-2.md`). #1075 merged on that corrected evidence.
- **Two budget rows had to be voided after the fact.** “Key to paint” and “one-screen scroll” were void in every browser and commit, from the probe at `2db29f2e` (`.scratch/tester/budget-pairs.md`). A control that could tell a broken probe should have run first.
- **A Firefox-only failure became a merged fix within the sprint.** The 375 px divider drag in `work-pane.spec.mjs` failed 3 of 3 on `main` in Firefox (`.scratch/tester/issue-ff-divider.md`), filed as #1187, fixed by #1189 (merged, branch `test/ff-divider-phone`). Its follow-up #1211 is still waiting on my Firefox run.
- **Work waited on reruns I couldn’t finish.** #1151’s before-and-after ran one sample per browser, and every run exited 1 on the two verdict tests (`.scratch/tester/b1151.md`), so #1159 still has no clean before-and-after.
- **CI runs browser specs only in Chromium** (#670), so Firefox findings depend on the Mac being free. #1187 and #1139 were both found there, not in CI.

## 4. Postbox itself

- **A turn that dies leaves an empty message.** it_g4DGibjY and it_z1UDrgEO are empty items, with no error and no “this turn failed”. A reader can’t tell a crash from silence.
- **A claim on a shared resource has no end when its holder dies.** My Mac claim (it_KR7eBkds) asked others to wait until I posted “done”, which I never did. Nothing in Postbox releases or flags it.
- **The room’s history is too large to read back.** `read_conversation` with skip 18 and limit 200 gave 93,232 characters, past the tool’s limit, and the room holds 9,573 earlier items. Finding my own sprint 4 messages took a search of a saved file.

## 5. For the next sprint

1. **Finish #1211’s Firefox run first,** at its current head, since lead-sweep’s label waits on it (it_KR7eBkds, pr-check.json).
2. **Give every claim a time limit,** and say in the working agreement that a claim lapses when its holder’s turn ends without “done”.
3. **Run a control before a measurement is reported,** one that fails on a known-broken probe, so no budget row needs voiding later (budget-pairs.md).
