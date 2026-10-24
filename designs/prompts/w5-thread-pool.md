# Prompt: wave 5, one session per agent, no forks, and ending a subagent (#228, #229)

A wave 5 session. The triage session integrates it, with an adversarial review subagent as the second reviewer. Follow [README.md](README.md) for the rules every session shares. Your ports are 5100–5149 for servers and 10400–10449 for Chrome.

This brief replaces its first version, which built #228’s option (a). The person reviewed the design on 23 October 2026 and chose something else. The decision is on #228.

---

You’re removing forks from Postbox, so that each agent has one session per conversation and the Agents pane shows its subagents. You’re also letting the person end a subagent. Work on the branch `fix/w5-thread-pool`, in one pull request: move commits if you need room, then one commit for #228 and one for #229.

## Why

- **#228 (P1):** threads grew their own pool of agents. In a manual UAT on v0.13.2:
  - A topic thread’s fork of @builder woke @reviewer. Postbox started a brand-new @reviewer session inside the thread, while the room’s @reviewer sat idle.
  - Naming both agents turned two agents into six sessions, including a fork of each fork.
  - The person then decided that the Agents pane should show an agent’s child sessions, which means its subagents, never forks of peers. Forks go entirely.
- **#229 (P1):** the person can’t end a child session by hand.

## The person’s decisions (#228, 23 October 2026)

1. **No forks, ever.**
   - A wake or a message to an agent that’s busy in another turn waits in its queue until its session is free. That’s the same queue a person’s message to a busy agent uses today.
   - No fork of a busy session, no fork of a fork, and no “Agents in this thread” pool.
2. **Topic threads use the agent’s one session in the conversation.** An agent @-mentioned in a topic thread answers from that session, so it remembers the thread.
3. **The conversation’s other agents know a thread exists.** Their catch-up shows a topic or side thread’s line, and they choose whether to read it with `read_conversation`. After the thread’s last reply, Postbox writes a summary of up to about 20 tokens, with a separate cheap model call (Haiku), and the line carries it.
4. **The Agents pane shows each agent’s subagents as its only children** (#191’s tree). End on a subagent’s row sends its parent agent an urgent note: the person ended that subagent, so stop it and don’t use its result.
5. **A persona not in the conversation:** when an agent wakes one, a card asks the person, “Add @x to this conversation?”.
   - On Allow, it joins with a note and gets the wake.
   - On Decline, the waking agent is told.
6. **One session per persona per conversation.** The conversation’s Agents section is its pool.
7. **Existing forks are archived at startup** when this ships.
   - Their threads keep their messages.
   - New messages there go to the conversation’s session.
   - Restore from Archived still works.
8. **No memory branching.** Principle 7 now says the person controls memory with new conversations, Compact and Archive.

intent.md already says all of this, marked “not built yet (#228)”. When it’s built, remove those markers in the same change.

## Read first

- [README.md](README.md), especially “Length limits”. `designs/intent.md`: principle 7, the introduction’s paragraph on conversations, the agent-tree row, the topic-thread row, and the one-session-per-persona row. `designs/architecture.md` on side threads, and §15.
- #228’s second decision comment, #229’s revision, and #191 for the subagent tree.
- The code on main:
  - `server/side-threads.mjs`: `agentWake`, `sideSession`, `forkBusy`, `forkFresh`, `forkNote`, `forkRetry`, `forkDone`
  - `server/runtime.mjs`: `sendMessage`, `startTopic` and `forkSession`, and the queue (`drainQueue`)
  - the agent tree in `app/js/agents.mjs`
  - `agentsSection(sideId, { label: 'Agents in this thread' })` in `app/js/thread.mjs`

## The work

- **#228, one session, no forks:**
  - **`sendMessage` in a topic thread:** an @-mentioned agent answers from its session in the parent conversation, with the reply posted in the topic thread. It has no `forkSession`.
  - **Side threads:** `sideSession` returns the conversation’s session. If that session is busy, the wake waits in its queue: `forkBusy` and its relatives go. The waking agent’s `wake_agent` returns at once, saying the agent is busy and will answer when it’s free.
  - **A persona not in the conversation:** `wake_agent` brings a card to the person. Allow joins it, with a note, and delivers the wake. Decline tells the waking agent. Reuse the hop card’s pattern from `resolveHop`.
  - **Catch-up and the thread summary:** another agent’s catch-up shows each topic and side thread’s line, with its summary. After a thread’s last reply settles, one Haiku call writes a summary of at most about 20 tokens, stored on the thread’s line.
    - Run one call per settled thread, debounced, and never while the thread’s agent is replying.
    - Without a Claude backend, or when the call fails, the line shows no summary and says nothing is wrong.
    - Record the call’s cost where the work ledger records spend.
  - **Migration:** at startup, archive every session that has `forkOf`, once. Its thread keeps its items, and the change is recorded so it doesn’t run again.
  - **UI:** remove “Agents in this thread” from the thread panel. One line, “@builder and @reviewer are in this thread”, is enough. The Agents section lists no forks.
  - **Guide:** update the side-thread and topic-thread lines in `server/adapters/guide.mjs`, within `guideText`’s 9,000-character budget. Say what a busy agent’s wake does now, and that adding a persona needs the person.
- **#229, ending a subagent:**
  - **End on every subagent’s row** in the Agents section, labeled “End @builder’s subagent ‘<what it was asked>’”.
  - It sends the parent agent an urgent note (the person ended that subagent, so stop it and don’t use its result), delivered as Postbox’s notes are. The row reads “ending”, until the subagent’s task ends or the turn ends.
  - Focus moves to the next row, or else to the agent’s row.

## Files

- **Yours:**
  - `server/side-threads.mjs`
  - `sendMessage`, `startTopic` and `forkSession` in `server/runtime.mjs`, moving what you need out first
  - the agent tree in `app/js/agents.mjs`
  - the thread panel’s agent section in `app/js/thread.mjs`
  - the side and topic lines in `server/adapters/guide.mjs`
  - a migration step in startup
  - `tools/check-side-threads.mjs` and `tools/check-agents.mjs`, or new checks
  - new `tests/side-threads-*.test.mjs` and `tests/runtime-*.test.mjs` files
  - intent.md’s markers
- **Shared:**
  - **`app/js/thread.mjs`:** the work-list session (#226) changes the work line under replies. Change only the thread panel’s agent section.
  - **`app/js/pane.mjs` and the pane:** the pane session (#222) owns them.
  - **`biome.json`:** add entries only for your new modules.

## Done when

- Each decision has a test that fails without it. Replay #228’s UAT through a real `Runtime` with the mock adapter:
  - no session with `forkOf` is ever made
  - a wake to a busy agent waits and is answered by the same session
  - a persona not in the room brings a card
  - existing forks are archived on startup
  - #229’s End note reaches the parent agent
- `check-agents` and `check-side-threads` cover:
  - a topic thread answered by the room’s session
  - the Agents pane with subagents only
  - End on a subagent by keyboard
  They run clean with `--lag 300`.
- The UAT docs for side threads, topic threads and the Agents section say what changed (text only).
