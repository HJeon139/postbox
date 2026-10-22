# Prompt: M3, checks that close the loop (#46, #53, #55, #56, #58)

A wave 1 session. Follow [README.md](README.md) for ports, file ownership, the gate and the hand-off. Your ports are 4600–4699 for servers and 9800–9899 for Chrome.

---

You’re building milestone M3. Postbox checks what agents send and feeds problems back to them, so they fix their own work. Today some checks feed back and some don’t, and the term check fires where it shouldn’t. Work in your own worktree, on the branch `fix/m3-checks`, with one commit per issue. Use subagents for independent pieces and for the adversarial review.

Read first:
- `designs/engineering-practices.md`
- `designs/prompts/README.md`
- `designs/architecture.md`, the sections on lints and diagram checks
- each issue with its comments: `gh issue view <n> --repo HJeon139/postbox --comments`

## One pipeline first

Before the issues, make the lint turn a single path. Today the term check (`server/lint.mjs`, called from `endTurn` in `server/runtime.mjs`) and the diagram check (`diagramCheck` in the runtime) each build their own message. The pipeline:
- Each check returns problems: `{ code, message, scope }`.
- `endTurn` gathers them into one lint turn per agent turn.
- Lint turns are capped (no lint of a lint reply, as now), and at most one per turn.
- A lint turn is quiet when the agent’s only response is a tool call, such as `define_term`. The transcript then shows a one-line system note (“@researcher defined “Step 2””), not a full reply.

Put this in its own commit, with tests, before the issues. It can share the first issue’s commit if it’s small.

## The issues

### #55: the term check flags terms the person introduced

Skip a numbered term (`NUMBERED` in `server/lint.mjs`) when it appears in the person’s messages in the thread, or in the title or headings of a block or app in the thread.

**Tests:** both cases, and a term that should still be flagged.

### #56: topic threads don’t inherit their conversation’s glossary

On the server, look terms up in the thread’s own glossary, then in its parent’s, following `parentId`. This applies to the check and to any server-side term handling. The topic’s own definition overrides its parent’s. The browser’s `glossaryOf` in `app/js/thread.mjs` already merges; check it matches.

**Tests:** a topic using a parent term isn’t linted; a topic redefinition wins.

### #46: a diagram that fails to draw isn’t fed back to the agent

The diagram frame already posts an `error` message, which `app/js/apps.mjs` only logs.
- Report it to the server the way size reports go (`/api/threads/:t/items/:i/diagram`), once per diagram, with Mermaid’s message and line.
- The runtime adds a problem to the pipeline.
- The person keeps seeing the frame’s “couldn’t be drawn” text, and Show source.

**Tests:** the runtime turns a reported error into one lint turn; a headless Chrome check covers a broken diagram end to end.

### #53: the app check passes charts too small to read

In the app’s pre-display check, measure the SVG marks and text after the app loads, at 375 and 1280 pixels. The check code is in `app/kit/kit.js` (check mode) and `startCheck` in `app/js/apps.mjs`. Report as warnings (`status: "note"`, so the app still shows), and send them to the agent through the pipeline:
- marks under 4 pixels
- text under 9 pixels on screen
- dash patterns too fine to tell apart

Also flag an app whose only visible text is an error or a missing-data message, which is #47’s symptom.

**Tests:** a fixture app with tiny marks and one with readable marks, in a headless Chrome check.

### #58: progress blocks can only say “in progress”

Follow the issue’s proposal:
- **Schema** (`shared/catalog.mjs`): an optional `progress: { done, total, unit? }`, `percent` and `eta` per step, all backward compatible.
- **Server:**
  - Stamp `updatedAt` on every `update_block`, and `startedAt` and `endedAt` when a step’s state changes.
  - Fill in `duration` from those times when the agent leaves it out.
  - When the agent’s turn ends with steps still running, mark them `stalled`, and tell the agent through the pipeline.
- **Browser** (the `progress` renderer in `RENDER` in `app/js/blocks.mjs`, and `app/workbench.css`):
  - a thin bar and “2 of 4 papers”
  - “Updated 40 s ago”
  - a live elapsed time on running steps
  - a `stalled` look
  - the running glyph turns, and holds still with reduced motion
- **Guidance:** the progress lines in `server/adapters/guide.mjs`, the `update_block` description in `server/mcp.mjs`, and the long-job recipe in `designs/recipes.md`.
- **UAT:** update `tests/uat/conversation/blocks/progress.md`.

### Also: raw HTML in a reply

The M1 session makes `<details>` and `<summary>` render (#71). Add a pipeline check that flags any other raw HTML tag in a reply, so the agent is told: Postbox shows it as text, and only `<details>` is supported. Mention it in the pull request under #71.

## Files

**Yours:**
- `server/lint.mjs`, and any new check module under `server/`
- `shared/diagram-lint.mjs`
- `shared/catalog.mjs`, the progress fields only
- the progress renderer and CSS
- `server/mcp.mjs`, the `update_block` description only
- `designs/recipes.md`

**Shared:**
- `server/runtime.mjs`: the lint section of `endTurn`, `diagramCheck`, `update_block` and `define_term`. The M4 session changes the needs-you computation at the top of `endTurn`; don’t touch it.
- `app/js/apps.mjs`: the diagram block in `enhanceMarkdown`, and `startCheck`. The hotfix session changes the bridge’s `event` case and full screen.
- `app/kit/kit.js`: check mode only. The hotfix session changes `postbox.send`.
- `server/adapters/guide.mjs`: progress lines only.

**Not yours:**
- `server/adapters/*` beyond those guide lines
- `app/js/thread.mjs`, except to verify `glossaryOf`
- `app/js/sheets.mjs`, `app/js/shell.mjs` and `app/js/ui.mjs`
- `server/seed.mjs`

## Done

- The gate in the README passes.
- Headless checks cover a broken diagram and a tiny-mark app.
- The review findings are fixed.
- The pull request is open, and the reviewing session has been messaged.
