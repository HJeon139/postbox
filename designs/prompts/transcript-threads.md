# Prompt: transcript and threads (#88, #91, #83, #93, #81, #82)

A wave 2 session, running beside M1 core. Follow [README.md](README.md) for the rules every session shares: ports, file ownership, the scope rule, the gate and the hand-off. Your ports are 4500–4599 for servers and 9700–9799 for Chrome.

---

You’re fixing six defects that wave 1’s UAT found in how the transcript follows agents and how topic threads carry context. Work on the branch `fix/transcript-threads`, with one commit per issue. Use subagents for independent pieces and for the adversarial review. **Don’t run the end-to-end UAT or the screenshot tools.** The reviewing session runs them.

## Why

In Dispatch mode you glance at a conversation to see what changed. That only works if the view stays on the newest message, the status line sits where you’re reading, and the controls show what’s already been sent. intent.md, principle 2: “If ‘needs you’ can’t be trusted, nothing else matters.” Wave 1’s manual UAT (the “Wave 1 Manual UAT” room, 22 October 2026) found each of these breaking during an ordinary session with two agents. Each issue has the evidence and the traced cause.

## Read first

- `designs/engineering-practices.md`, `designs/prompts/README.md` (especially the scope rule), and `designs/intent.md`
- each issue with its comments: `gh issue view <n> --repo HJeon139/postbox --comments`

## The issues

### #88: the view doesn’t stay on the newest message, and app updates have no author (P1)

- **Stick to the bottom.**
  - A `stuck` state is set when you reach the bottom and cleared only by your own upward scroll (wheel, keys or a drag), not by content growing.
  - While it’s set, re-pin after any change: streaming, item patches, app frames growing, the thread panel opening or closing, and window resizes. A `ResizeObserver` on the transcript covers most of these in one place.
  - Set `overflow-anchor` so browsers behave the same.
- **Name the agent on apps:** the app item shows its author like other blocks (`who(it)`), and an update shows who made it. Moving an updated app to the bottom is #49, in wave 3, so leave it.
- **Tests:** headless checks for each case in the issue’s acceptance list. At the bottom:
  - an app growing from 200 to 700 px leaves you at the bottom
  - opening and closing the panel leaves you at the bottom
  - scrolled up, nothing moves you

### #91: “Jump to latest” shows when you’re at the latest (P2)

- Reset the count and hide the pill whenever you reach the bottom by any means. Share #88’s state rather than adding a second one.
- The pill never covers the working row or the last message.

### #83: the working row doesn’t line up with the messages (P2)

- The working rows use the message column’s width and left edge, at 1280 px, with and without the thread panel.
- A long tool line still truncates inside the column.

### #93: Summarize back can post the summary twice (P2)

- When the summarize turn posts its summary, mark that turn’s replies in the topic thread as sent (`sharedAt`), so they show “Sent to the conversation”, and the server’s 409 covers a stale button.
- Disable Send to conversation while its request is pending.
- Disable Summarize back while a summary is pending, from the request until it’s posted or the turn fails, with “Summary requested…”. The server refuses a second request (409), so two tabs can’t double it.

### #81: an agent @-mentioned into a topic thread can’t see the message it’s about (P1)

- When a session joins a topic thread without a fork point, its first catch-up starts with the thread’s root message from the parent conversation, described as `describeItem` does: “This thread started from @researcher’s message: …”. That covers blocks and apps by their title and fallback.
- A fork doesn’t get the root twice.
- **Tests** in `tests/runtime.test.mjs`: a fresh joiner sees the root in its first turn, and only once, for a root that’s an agent message, a block or your own message.

### #82: bold text that contains inline code shows its asterisks (P2)

- In `shared/markdown.mjs`, code spans bind first, and emphasis may contain them, as CommonMark does.
- **Tests:** bold and italic around code, punctuation before the closing delimiter, and in list items.
- Keep every existing markdown test passing, including #71’s `<details>` tests.

## Files

**Yours:**
- In `app/js/thread.mjs`: `mountTranscript` (scrolling, the pill and the working rows), `fillWorkRow`, `messageActions`, the app case in `renderItem`, and `mountSidePanel`.
- In `server/runtime.mjs`: `catchUp`, `shareToConversation`, and the end of a summarize turn.
- In `app/workbench.css`: the transcript, `.working` and `.jump` rules.
- `shared/markdown.mjs` and its tests.

**Not yours:** M1 core (`designs/prompts/m1-core.md`) runs at the same time and owns these:
- in `app/js/thread.mjs`: the composer (`mountComposer`), the permission and denial cards, and a new `command` case in `renderItem`
- `app/js/shell.mjs`, `app/js/sheets.mjs`, `app/js/apps.mjs`, `app/js/blocks.mjs` and `app/kit/*`
- `server/adapters/*`, `server/mcp.mjs` and `server/index.mjs`
- the persona, permission and `update_block` code in `server/runtime.mjs`
- `shared/catalog.mjs` and `shared/events.mjs`

Change only the functions named above, and don’t reformat code around them.

## Done

- The gate in the README passes, with a headless Chrome check for each visible change (#88, #91, #83, #93).
- The UAT docs these issues affect are updated as text: the transcript, the thread panel and topic threads.
- The review findings are fixed, and anything declined is listed with its reason.
- The pull request is open, and the reviewing session has been messaged with the URL, the head and one line per issue on how it was verified.
