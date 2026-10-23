# Prompt: wave 5, one pool of agents, and ending a fork (#228, #229)

A wave 5 session, added after #223 (side threads) merged. The triage session integrates it, with an adversarial review subagent as the second reviewer. Follow [README.md](README.md) for the rules every session shares. Your ports are 5100–5149 for servers and 10400–10449 for Chrome.

---

You’re making the project’s agents the only pool of agents, and letting the person end a fork, on the branch `fix/w5-thread-pool`, in one pull request: a move commit if you need room, then one commit for #228 and one for #229.

## Why

- **#228 (P1):** threads grow their own pool of agents. In a manual UAT on v0.13.2 (23 October 2026):
  - A fork of @builder in a topic thread woke @reviewer. Postbox started a brand-new @reviewer session inside the topic thread, with none of the conversation’s memory, while the room’s @reviewer sat idle.
  - Naming both agents turned two into six sessions: the room’s two, a fork of each in the topic thread, and a fork of each fork in a side thread under it, made because each fork was busy.
  - The sidebar showed two idle agents, and the thread panel had its own “Agents in this thread” list.
  - The person decided option (a) (the decision is on #228):
    - Topic-thread forks stay, for principle 7.
    - They show and count as the room’s agents, under their agent’s row in the sidebar.
    - A fork never forks again.
    - The thread’s own agent list goes.
- **#229 (P1):** the person can’t end a child session. A fork’s row has only Stop, shown only while it works, and Stop ends a turn, not the fork. The person asked for “a UX feature to manually terminate child sessions”.

## Read first

- [README.md](README.md), especially “Length limits”. `designs/intent.md`: principle 7, principle 6, and the agent-tree row in Layout, the one that starts “One session per persona per conversation”. `designs/architecture.md` on side threads, and §15.
- #228 and #229 in full, with #228’s decision comment.
- #171, #128 and #223 for how side threads work now: `server/side-threads.mjs` (`agentWake`, `sideSession`, `forkBusy`, `forkDone`), and `sendMessage`, `forkSession` and `ensureSession` in `server/runtime.mjs`.
- The agent tree in `app/js/agents.mjs`, and the thread panel’s `agentsSection(sideId, { label: 'Agents in this thread' })` in `app/js/thread.mjs`.

## The work

- **#228, the pool:**
  - **One pool.** An agent in a topic thread or a side thread that wakes or asks another agent reaches one of two sessions, in this order:
    1. that persona’s fork already in this topic thread
    2. else its session in the room the thread belongs to
  - **No fork of a fork,** and no new session for a persona who isn’t in the room. If the session it reaches is busy, the request waits for it, as a message to a busy agent does (the queue), instead of forking.
  - **A persona not in the room** can’t be pulled into a thread by an agent. The tool answers that the person has to add it to the room first, or that the agent can `propose_agent`, which the person approves.
  - **The person’s @-mention in a topic thread** still brings in a fork of the agent’s room session, as now. That’s the person choosing (principle 7).
  - **Shown as the room’s agents.** Every fork is listed under its agent’s row in the sidebar’s Agents section, with its thread, its state and Stop, as #171’s side-thread forks are. It counts toward that agent.
  - **Remove “Agents in this thread”** from the thread panel. The panel can say which of the room’s agents are taking part, in one line, but it isn’t a list of agents of its own.
  - **intent.md:** update principle 7 and the agent-tree row to say that threads use the project’s agents: forks for topic threads, never a fork of a fork, and no pool per thread. Give the reason (#228).
- **#229, ending a fork:**
  - **End on every fork’s row** in the sidebar’s tree, always shown, labeled “End @builder’s fork in <thread>”.
    - On a working fork, End stops it first, by Stop’s path, including #129’s question about background jobs.
    - Then it archives the fork (`/api/sessions/:id/archive`).
    - A toast offers Undo (`/restore`).
  - **An ended fork:**
    - Its row goes.
    - Its thread keeps its messages, with a line saying the person ended the fork.
    - It never answers a later message or wake. Those follow the pool rule above.
  - **The agent hears of it:** the agent the fork came from is told on its next turn that the fork was ended, and where to read what it did, as `forkDone` tells it today.
  - **Focus:** after End, focus moves to the next row, or else to the agent’s row.

## Files

- **Yours:**
  - `server/side-threads.mjs`
  - the session lookup in `sendMessage`, `forkSession` and `ensureSession` in `server/runtime.mjs`, moving what you need out first
  - the agent tree in `app/js/agents.mjs`
  - `agentsSection`’s use in `app/js/thread.mjs`’s thread panel
  - `tools/check-side-threads.mjs` and `tools/check-agents.mjs`, or new checks
  - new `tests/side-threads-*.test.mjs` files
  - intent.md’s principle 7 and the agent-tree row
- **Shared:**
  - **`app/js/thread.mjs`:** the work-list session (#226) changes the work line under replies. Change only the thread panel’s agent section.
  - **`app/js/pane.mjs` and the pane:** the pane session (#222) owns them. Don’t change them.
  - **`biome.json`:** add entries only for your new modules. The integrator lowers `runtime.mjs`’s ceilings.

## Done when

- Each issue has a test that fails without its fix:
  - #228’s two UAT cases, replayed through a real `Runtime` with the mock adapter. No session for a persona outside the room, no fork of a fork, and the room’s @reviewer answers the request or the request waits for it.
  - #229: End on an idle fork and on a working one, Undo, and an ended fork that never answers again.
- `check-agents` and `check-side-threads` cover forks under their agent’s row, the thread panel without its own list, and End by keyboard, clean with `--lag 300`.
- The UAT docs for side threads and the Agents section say what changed (text only).
