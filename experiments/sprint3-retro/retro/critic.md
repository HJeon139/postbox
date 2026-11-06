# Sprint 3 retrospective: critic

## 1. Setup
- **Helped:** fresh subagents for adversarial passes found what I'd have missed. On #780 they found the staged-put data-loss P1 in `blobs.mjs` and the untested review-type check (sign-off comment on #825, 6674783852).
- **Helped:** a sign-off script (per-commit Biome via `git archive`, `merge-tree`, Biome on the merged tree) made each sign-off checkable (e.g. #802 comment 6668866037).
- **Got in the way:** the script's own exit code. It posted #770's sign-off and label over a `merge-tree` conflict right after #760 merged; I retracted it within a minute (#770 comments 6674560580, 6674580781). Before that it also didn't gate on the per-commit result (found while signing #777, comment 6673079130).
- **Got in the way:** hand-backs arriving as summaries in the room while the head had moved. #780's "four items done" message at `37abe944` didn't contain the P1 fix (only a test file changed); I had to diff to see it.

## 2. Planning
- **Worked:** a hard 4 PM checkpoint for #780's security read forced a scope: the P1 fix landed at `4d19d373` before it (#825).
- **Worked:** the person's rule that a red check means not ready (#775's CodeQL, 5 Nov) removed every "noted" exception after that.
- **Change:** the freeze ran on the wrong clock. Several messages said PDT after daylight time ended, and #826 was nearly punted on that premise (s3-826-after-freeze). Times in UTC from the start.
- **Change:** an ordering rule for stacked PRs. A retarget to `main` doesn't start CI, so CodeQL never ran on #783 after #777 merged, and a close and reopen didn't start it either (lead-delivery, after the reopen: still 17 checks, no CodeQL). Plan how CodeQL runs on the new base before stacking, not at the end.

## 3. Execution
- **Flowed:** once a hand-back was posted and CI was green, sign-off took one script run (#775 6669338835, #826 6674682026).
- **Waited:** the S3 rule 6 order (hand-back posted before sign-off) left #802 and #777 ready but unsigned for about 40 minutes while the hand-backs waited on the person and the poster; scrum-master first called me the bottleneck.
- **Worst wait:** #770 and #808, chained on #760's merge. #770 conflicted with `main` in `tools/uat/triggers-host.mjs` once #760 landed, needed a rebase, UAT rerun and new sign-off (`2da556e4`, comment 6674996943), and #808 still sits behind it.
- **Waited:** silent waits stopped agents' turns (lead-delivery and lead-host-install, room note at about 21:14 UTC), costing re-wakes.

## 4. Quality: sent back after my sign-off
- **#777 round 2 → 3:** an observer that recorded nothing passed PF-1 once `MAX_MISSING_SHARE` was removed. Missed: asking what the report says when its measurement is empty. Check: a positive control (the calibration key the round-3 fix added).
- **#770 (`c961ce7c`):** `supersedeTry` wrote `installed` for the person's own Install…, so the card said "by itself" and `host-auto-installed` counted it. Missed: every reader of a reused outcome value. Check: grep the readers (I did this on the fix, `present`).
- **#760 (earlier heads, 4–5 Nov):** a flag recorded for every kind of stop, then a pre-existing `by: 'you'` writer (`store-outage.mjs:225`). Check: grep every writer of a value a PR starts reading.
- **#743, #755, #781, #758, #776 (4–5 Nov):** per-commit Biome, a toggle racing its action, a new name already on `main`, a removed guard reached by lagged specs, a catch-up read from pending. Each is now a line in my label checklist; none recurred this sprint.

## 5. Postbox and the hosts
- **Permission prompts:** every `gh` and git call I ran needed the person's allow (the room shows dozens of "Allowed: @critic to run a command"). A read-only allow list for `gh pr checks/view`, `git fetch/merge-tree/archive` would remove most.
- **Time zones:** agents' clocks and messages disagreed by an hour (UTC−8 vs "PDT"), which moved a freeze decision.
- **Stopped turns:** a command quiet for 15 minutes stops the turn; three leads lost turns this way (scrum-master's note, about 21:20 UTC).
- **Flaky CI under load:** #755's consent-off test on a slow disk (fixed in #770) and a browser shard cancelled at 20 minutes with no log (#770 run 42124671370) each cost a rerun.

## 6. For sprint 4, in order
1. **A read-only allow list** for the review commands (`gh pr checks/view/diff`, `git fetch/merge-tree/archive/rev-list`), so sign-offs don't wait on prompts.
2. **A shared sign-off tool in the repo** (per-commit Biome, `merge-tree` against fresh `main`, merged Biome, `gh pr checks` incl. CodeQL), that exits non-zero on any failure and that every lead runs before asking for review.
3. **Stacked-PR rule:** after a base merges, rebase or retarget, then get CodeQL running on the new base (a close and reopen did not do it for #783; find what does); and re-run the test merge after every merge to `main`, not only at review time.
