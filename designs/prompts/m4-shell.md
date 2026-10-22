# Prompt: M4, the shell (#4, #26, #29, #69)

A wave 1 session. Follow [README.md](README.md) for ports, file ownership, the gate and the hand-off. Your ports are 4700–4799 for servers and 9900–9999 for Chrome.

---

You’re fixing the four issues in milestone M4 that don’t wait on M1. They’re about words, focus, menus and the needs-you state. Work in your own worktree, on the branch `fix/m4-shell`, with one commit per issue. Use subagents for independent pieces and for the adversarial review.

Read first:
- `designs/engineering-practices.md`, especially accessibility
- `designs/prompts/README.md`
- `designs/intent.md`, the interface rules: nothing hover-only, and amber is the only interaction color
- each issue with its comments: `gh issue view <n> --repo HJeon139/postbox --comments`

## The issues

### #69: an unanswered block keeps its agent “needs you” after the conversation moved on

**Cause.** In `endTurn` (`server/runtime.mjs`), `needs` counts every unanswered asking block from that agent anywhere in the conversation.

**Fix.**
- Count only the asking blocks from the turn that just ended.
- Show older open blocks quietly: “1 open review” on the overview card and in the conversation, not the needs-you state.
- A needs-you that came from a block clears when you send the agent a new message, as it does now.

**Tests:** in `tests/runtime.test.mjs`.

### #4: one word for conversations, another for threads

Direct messages and rooms are *conversations*. *Thread* means a topic or side thread only.

**Fix.**
- Fix every string that says otherwise. Start with these in `app/js/sheets.mjs`: “Join this thread”, “New thread in …” and “… becomes a room”. Then “Open thread” in `app/js/shell.mjs` (the overview card and session menu) and the system lines in `app/js/thread.mjs`.
- Add a project copy rule to `tools/lint-copy.mjs` that flags “thread” where a conversation is meant, with a small allowlist for topic and side threads, so it doesn’t come back.
- Update the UAT docs that quote the old words.

### #26: focus is lost in sheets and after menus

**Cause.** Each sheet’s `paint()` rebuilds its whole body. `openDialog` records `document.activeElement` after the menu item that opened it is gone.

**Fix.**
- **Restore focus after a repaint:** to the same control by id, or by position when the id changes.
- **Return focus to the opener:** `openMenu` passes the menu’s anchor to the dialog it opens, so focus goes back there.
- **The folder picker** opens with focus on its first entry.
- **Cover every case in the issue:**
  - a Tools checkbox
  - a room’s agent chips
  - the Settings tabs
  - ⋯ › Add an agent, then Escape
  - the folder picker

**Tests:** a headless Chrome check with real key presses for each case.

### #29: clicking a menu’s button again doesn’t close it

**Fix.** In `openMenu` (`app/js/ui.mjs`), a click on the menu’s own anchor closes it, with `aria-expanded` set to “false”. This applies to every menu, including the Postbox mark and ⋯.

**Tests:** in the same headless check.

## Files

**Yours:**
- `app/js/ui.mjs`: menus, dialogs and focus
- `app/js/shell.mjs`
- `tools/lint-copy.mjs`
- the copy and repaint code in `app/js/sheets.mjs`

**Shared:**
- `app/js/sheets.mjs`: the hotfix session adds two persona controls to `backendFields` (#57); don’t change `backendFields`.
- `server/runtime.mjs`: only the `open`/`needs` computation at the top of `endTurn`. The M3 session changes the lint section below it.
- `app/js/thread.mjs`: only strings that say “thread” for a conversation. The hotfix session changes the composer and attachments.

**Not yours:**
- `server/adapters/*`
- `app/js/apps.mjs`, `app/js/blocks.mjs` and `app/kit/*`
- `server/lint.mjs`
- `server/seed.mjs`
- `shared/*`

## Done

- The gate in the README passes.
- A headless check covers each focus case and the menu toggle.
- The review findings are fixed.
- The pull request is open, and the reviewing session has been messaged.
