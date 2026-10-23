# Prompt: wave 5, side threads (#124, #128, #151, #130)

A wave 5 session, carried over from wave 4, where it never started. The triage session integrates it, and the architectural review session reviews it. Follow [README.md](README.md) for the rules every session shares. Your ports are 4650–4699 for servers and 9850–9899 for Chrome.

---

You’re finishing side threads after #171 (one session per persona per conversation, side-thread forks shown and stoppable), on the branch `fix/w5-side-threads`, in one pull request. The first commit moves the side-thread code out of `server/runtime.mjs` (README.md, “Length limits”), then one commit per issue.

## Why

Side threads are where agents talk to each other. The person can now see who’s working there and stop them (#171), but four gaps remain between what happens there and what the person can see or use:
- **#124:** agent-to-agent threads don’t appear on the Threads page; threads the person took part in do (the person’s screenshot).
- **#128, the part #171 left open:** nothing in a side thread can be sent back to the conversation. The person asked an agent to “post these details in the main chat”, and it couldn’t: the room only ever shows “talked in a side thread (n messages)”. Topic threads already have Summarize back.
- **#151:** a failed turn in an agent-to-agent thread shows only inside the thread. The room shows the asking agent idle, and the Open link on its line didn’t open the thread.
- **#130:** the side thread’s message count updates only on wakes and replies to a wake (`bumpSideLink`). A line read “4 messages” over 21, and agents read the same stale count in their catch-up.

Then, if time allows, two P2s on the same lines: #135 (a later turn from the same agent shows with no name or time) and #114 (wake notices crowd the conversation: seven system lines for one fix request).

## Read first

- [README.md](README.md), `designs/intent.md` (Layout: the right-pane and agent-tree rows) and `designs/architecture.md` on side threads.
- Each issue with its comments. #128 records the person’s decision on joining: a woken persona joins the conversation, with a visible note.
- #171’s code: `sideSession`, `forkBusy`, `forkDone`, `roomOf` and the sidelink item in `server/runtime.mjs`; the agent tree in `app/js/agents.mjs`, with #191’s subagents in it.
- `designs/architecture.md`, “Module and function size”, and README.md, “Length limits”.

## The work

- **First, the move:** move the side-thread functions (`agentWake`, `sideSession`, `forkBusy`, `forkFresh`, `forkNote`, `forkRetry`, `forkDone`, `resolveHop`, `bumpSideLink`, `recordAgentMessage`) into `server/side-threads.mjs`, by the rewrite README.md’s “Length limits” allows (`this` becomes `rt`, and `Runtime` keeps a one-line delegator for each), with their ceilings. Nothing else changes in that commit. They’re one unbroken run in `runtime.mjs`, from `agentWake` to `recordAgentMessage`.
- **#124:** the Threads page lists side threads with their pair, state and last activity, beside topic threads, and says which kind each is.
- **#128, two ways back to the conversation** (the person’s decision of 23 October, recorded on #128):
  - **The person:** “Send to conversation” on a side-thread message, with the same contract as a topic thread’s Summarize back: the person chooses what goes, and it posts in the conversation as theirs.
  - **An agent the person asked:** an MCP tool, `share_to_conversation { text }`, offered only in side and topic threads. It posts a `shared` item in the conversation, marked as shared by that agent from that thread, and wakes no one, so it doesn’t count against the wake limit. Under principle 7, the person who asked counts as the sender. The guide says when to use it: only when the person asks for something to go to the main chat.
  - Nothing else flows back on its own (intent.md, principle 7).
- **#151:** a failed side-thread turn puts its retry card where the room can see it: on the side-thread line, and in `needsYou` with `needs.threadId`, as #171 does for permission cards. The line’s Open opens the thread at the card.
- **#130:** count every item added to a side thread, through `addItem`, not only wakes.

## Files

- **Yours:** `server/side-threads.mjs`, and the lines in `server/runtime.mjs` that call it, `share_to_conversation` in `server/mcp.mjs` and its line in `server/adapters/guide.mjs` (within `guideText`’s 9,000-character budget), the Threads page in `app/js/shell.mjs` (`mountThreads`), side-thread rendering in `app/js/thread.mjs`, `tools/check-side-threads.mjs` and `tests/side-threads.test.mjs`.
- **Shared:**
  - **`server/runtime.mjs` and `biome.json`:** every wave 5 session moves its own concern out of `runtime.mjs` first. Move only the functions above. Add a `biome.json` entry only for your new module, and leave `runtime.mjs`’s override to the integrator (README.md, “Length limits”).
  - **`app/js/agents.mjs`:** change only the side-thread entries. #191’s subagent entries stay as they are.
  - **`app/js/thread.mjs`:** the work-list session changes the work line under replies. Change only side-thread rendering.
  - **`app/js/shell.mjs`:** the pane session changes the rail’s collapse. Change only `mountThreads`.

## Done when

- Each issue has a test that fails without its fix, and `check-side-threads` covers #124, #128 and #151 in the page, clean with `--lag 300`.
- #128’s acceptance holds both ways: the person can send a side-thread message to the conversation, and an agent in a side or topic thread that’s asked to post this in the main chat can do it.
- The UAT docs for side threads and the Threads page say what changed (text only).
