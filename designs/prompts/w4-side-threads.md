# Prompt: wave 4, side threads (#124, #128, #151, #130)

A wave 4 session, integrated by the triage session and reviewed by the reviewing session. Follow [README.md](README.md) for the rules every session shares. Your ports are 4650–4699 for servers and 9850–9899 for Chrome.

---

You’re finishing side threads after #171 (one session per persona per conversation, side-thread forks shown and stoppable), on the branch `fix/w4-side-threads`, in one pull request with one commit per issue.

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
- #171’s code: `sideSession`, `forkBusy`, `forkDone`, `roomOf` and the sidelink item in `server/runtime.mjs`; the agent tree in `app/js/agents.mjs`.

## The work

- **#124:** the Threads page lists side threads with their pair, state and last activity, beside topic threads, and says which kind each is.
- **#128:** “Send to conversation” on a side-thread message, with the same contract as a topic thread’s Summarize back: the person chooses what goes, and it posts in the conversation as theirs. Nothing flows back unless the person sends it (intent.md, principle 7).
- **#151:** a failed side-thread turn puts its retry card where the room can see it: on the side-thread line, and in `needsYou` with `needs.threadId`, as #171 does for permission cards. The line’s Open opens the thread at the card.
- **#130:** count every item added to a side thread, through `addItem`, not only wakes.

## Files

- **Yours:** the side-thread code in `server/runtime.mjs` (`agentWake`, `sideSession`, `bumpSideLink` and the sidelink item), the Threads page in `app/js/shell.mjs` (`mountThreads`), side-thread rendering in `app/js/thread.mjs`, `tools/check-side-threads.mjs` and `tests/side-threads.test.mjs`.
- **Shared:**
  - **`app/js/agents.mjs`:** the agent-activity session (#73) adds subagents as children in #171’s tree. Change only the side-thread entries, and expect it to rebase on you.
  - **`app/js/shell.mjs`:** the supervision session owns the overview. Change only `mountThreads`.

## Done when

- Each issue has a test that fails without its fix, and `check-side-threads` covers #124, #128 and #151 in the page, clean with `--lag 300`.
- The UAT docs for side threads and the Threads page say what changed (text only).
