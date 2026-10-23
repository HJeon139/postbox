# Prompt: wave 5, UAT checks that recur for real (#213)

A wave 5 session. The triage session integrates it, and the architectural review session reviews it. Follow [README.md](README.md) for the rules every session shares. Your ports are 5000–5049 for servers and 10300–10349 for Chrome, if a test needs either.

---

You’re making a UAT finding that comes back mean the defect came back, on the branch `fix/w5-uat-checks`, in one pull request, with a commit for each of #213’s four parts.

## Why

The person asked for recurring UAT findings to be prioritized (23 October 2026). Recurrence is only a signal if a finding that comes back is real. Across the 15 finished runs counted on 23 October 2026, the checks that came back most often were mostly checks written before their issue’s fix:
- **#123’s check (a P0)** fired in two runs after #123 closed, because `blockHistory` reads a block’s revision only from `item.patch`, and a block that follows the conversation gets it through `item.move` (#92, #173).
- **#49’s check** fires on any updated app more than 6 items from the bottom, although an update now moves the app to the newest point.
- **#63’s check** flagged status reports and exercise answers as questions and drafts.
- **The preset** marks a check that matches a closed issue as a duplicate, so none of the 11 hits after an issue closed was verified. A real regression and a stale check look the same.

#213 has the table and the evidence.

## Read first

- [README.md](README.md); `tests/uat/e2e/README.md` (“Verdicts, and filing what a run finds”, “Refitting the scale”, and “Recurring findings”, which this wave adds).
- #213, with its table and proposal.
- `tools/uat/checks.mjs` (`blockHistory`, `approval-for-other-revision`, `updated-app-far-up`, `prose-instead-of-block`), the preset and verify steps in `tools/uat-run.mjs` and `tools/uat/`, `tools/uat-stats.mjs` and `tools/uat/stats.mjs`.
- `shared/state.mjs`’s `item.move`, and `bringForward` in `server/runtime.mjs`.

## The work

- **First, make room**, if a file you change is at its ceiling (README.md, “Length limits”). `tools/uat/checks.mjs` is.
- **The two stale checks:**
  - `blockHistory` follows `item.move`’s patch: revision, answered and answer.
  - `updated-app-far-up` counts only the items that were already after the app when its last version landed.
  - Each gets a test that replays a moved block, or a moved app.
  - A fixture with a real unread reopening by `item.move` still fires.
- **`prose-instead-of-block`:** a reply that reports what was done, or answers an exercise inside `<details>`, isn’t a question or a draft. Measure the check’s precision on every finished run’s hits, before and after, and put both numbers in the pull request. The labels come from the verdicts a reviewer or verifier set. Where there’s none, label the hit yourself and list your labels in the pull request, so the number has a source.
- **A closed issue caught again:**
  - The preset doesn’t apply to it. Whether the run’s commit (`run.json`) has the fix needs no model: take the fix from the issue’s closing pull request (`gh issue view N --json closedByPullRequestsReferences`), then `git merge-base --is-ancestor <fix> <run commit>`. The verifier then judges only whether the evidence shows the defect.
  - Confirmed: the runner comments on the issue with the evidence. The triage session or the person reopens it. The runner never does.
  - Not confirmed: the verdict is `harness`, with the check named.
  - A run without a recorded commit says so, and its findings on closed issues aren’t verified.
- **Recurrence in `uat-stats`:** a table by issue, for open and closed issues, with its runs, its findings, the runs after it closed, its state and its priority. It counts what tests/uat/e2e/README.md, “Recurring findings”, counts: only `duplicate` verdicts by `verdictOf()`, without `measurement` findings or coverage rows. Sort it by runs, then findings.

## Files

- **Yours:** `tools/uat/checks.mjs`, the preset and verify code under `tools/uat/` and in `tools/uat-run.mjs`, `tools/uat-stats.mjs`, `tools/uat/stats.mjs`, new `tests/uat-checks-*.test.mjs` and `tests/uat-stats-*.test.mjs` files, and `tests/uat/e2e/README.md`.
- **Shared:** none of wave 5’s other sessions changes `tools/uat/`. Don’t run a live UAT (README.md). Replay the finished runs with `--recheck <run> --file no`, which makes no model call, and with `--verify yes` only for the closed-issue step, once.

## Done when

- Each part has a test that fails without it.
- Rechecking every finished run, including the four of 23 October 2026 at 21:00 or later: #123’s and #49’s checks no longer fire on revisions or apps that moved, and no finding that matches a closed issue is preset as a duplicate.
- `uat-stats` prints the recurrence table, and a test keeps its columns.
- `tests/uat/e2e/README.md` says how recurrence is read, under “Recurring findings”.
