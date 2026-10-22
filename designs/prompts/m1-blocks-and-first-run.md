# Prompt: M1 issues that don’t need #57 (#62, #70, #71, #43)

A wave 1 session. Follow [README.md](README.md) for ports, file ownership, the gate and the hand-off. Your ports are 4500–4599 for servers and 9700–9799 for Chrome.

---

You’re fixing four issues from milestone M1 that don’t depend on how agents load settings (#57, done in another session). Work in your own worktree, on the branch `fix/m1-blocks-and-first-run`, with one commit per issue. You may use subagents for independent pieces and for the adversarial review.

Read first:
- `designs/engineering-practices.md`
- `designs/prompts/README.md`
- each issue with its comments: `gh issue view <n> --repo HJeon139/postbox --comments`

## The issues

Commit them in this order.

### #62: Markdown tables in review blocks show as raw pipes

**Cause.** `renderReview` in `app/js/blocks.mjs` renders `b.content` line by line, so tables, fences, multi-line lists and quotes never parse.

**Fix.**
- Group consecutive source lines into Markdown blocks, render each group with `renderMarkdown`, and keep a comment target for each source line inside it: one per table row, and the delimiter row has none.
- In diff mode (`previous` set), group after `diffLines`, so an added or removed row still shows as added or removed.
- Put the grouping in `shared/` as a pure function, tested in `node:test` with tables, fences, lists, quotes and diffs.

### #70: review blocks show a comment button on every line

**Fix.** Make the line itself the comment target:
- Clicking a line, or tabbing to it and pressing Enter, opens its comment box.
- One dim gutter mark per line instead of a button, visible without hover.
- Each line gets an accessible name (“Comment on line 12”).

With #62’s grouping, a table gets one target per row. Keep the existing comment, verdict and send behavior, and the keyboard order.

### #71: agents can’t hide an exercise’s answer, so `<details>` shows as raw tags

**Fix.**
- Support `<details>` and `<summary>` in `renderMarkdown` (`shared/markdown.mjs`), and only those. Accept them with no attributes; render Markdown inside them; and nest correctly. A tag with attributes, an unclosed tag, or anything else stays text, as now.
- Add one line to the reply rules in `server/adapters/guide.mjs`: hide an exercise’s answer with `<details><summary>Answer</summary> … </details>`, which is the only HTML Postbox renders.
- Tests: rendering, nesting, attributes kept as text, unclosed tags, and attempts at script or event handlers.
- The check that flags other raw HTML in replies belongs to the M3 session; don’t add it here.

### #43: a fresh install comes with use-case agents

**Fix.**
- **A fresh install (no `--demo`)** seeds one generic agent and no sample projects or conversations.
  - Call it something plain, such as @assistant.
  - Its instructions should be short and general.
  - It runs on Claude Code when it’s installed, and on the mock otherwise.
- **With `--demo`**, the current personas, projects and conversations stay, since `tools/demo.mjs`, `tools/shoot-app.mjs` and the tests depend on them.
- **The code:**
  - Pass the mode from `server/index.mjs` to `seed()` in `server/seed.mjs`.
  - Export the fresh-install defaults as a pure function, so a test and the UAT check can read them.
  - Keep `agents.json` in the data folder overriding both modes.
- **Keep the end-to-end UAT working.** Its scenarios use @researcher and @critic:
  - Add `tests/uat/e2e/personas.json` with those two personas (copy their current definitions).
  - Have `tools/uat-run.mjs` write the scenario’s agents to `agents.json` in the run’s data folder before Postbox starts.
  - Change the `fresh-install-agents` check in `tools/uat/checks.mjs` to read the fresh-install defaults from `server/seed.mjs`, not the run’s personas, and update its test.
- Update the README’s first-run section, and the UAT docs for the empty overview and the first run.

## Files

**Yours:**
- `shared/markdown.mjs`, a new grouping module in `shared/`, and their tests
- `renderReview` and the review CSS in `app/js/blocks.mjs` and `app/workbench.css`
- `server/seed.mjs`
- the `seed()` call in `server/index.mjs`
- `tests/uat/e2e/personas.json`

**Shared:**
- `server/adapters/guide.mjs`: add only the one `<details>` line.
- `tools/uat-run.mjs`: only the `agents.json` step.
- `tools/uat/checks.mjs`: only `fresh-install-agents`. The hotfix session edits `settings-leak` in the same file.

**Not yours:**
- `server/adapters/*` beyond that guide line
- `app/js/apps.mjs`, `app/js/thread.mjs`, `app/js/sheets.mjs` and `app/js/ui.mjs`
- `server/lint.mjs`
- `endTurn` in `server/runtime.mjs`

## Done

- The gate in the README passes.
- A headless Chrome check covers: a table in a review block, comment targets (count and keyboard), `<details>` folding, and a fresh install’s overview.
- The review findings are fixed.
- The pull request is open, and the reviewing session has been messaged.
