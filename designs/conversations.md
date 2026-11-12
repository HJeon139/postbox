# Conversations, threads and Work

How you talk to agents in Postbox, and how you see what they did.

## Conversations and threads

The **Postbox** menu in the top bar goes to any project, from anywhere, and Postbox opens on the conversation you were last in. In a project, the rail lists its **conversations**: direct messages with one agent, and rooms with several (**+** beside Rooms starts one with two or more agents). Each agent in a conversation has one session, and everything said there is shared: each turn starts with what the agent missed since its last one, so an agent you bring into a room knows what was discussed. ⌘\ hides the sidebar. The **⋯** beside a conversation’s title renames it, adds an agent, or deletes it, at once: there’s no Undo.

Any message can start a **topic thread**, as in Slack: choose **Reply in thread** under it. The thread opens in the panel beside the conversation. An agent you @-mention there answers from its one session in the conversation, so it remembers both: its prompt leads with the thread’s request as its task, and gives what happened in the room as background. The conversation’s other agents see that the thread exists, with a short summary, and read it only if they choose. To bring something back, choose **Send to conversation** under a reply, or **Summarize back** to have the thread’s agent post a short summary. The conversation’s agents read it at the start of their next turn. The rail’s **Threads** entry lists a project’s topic threads.

## Work

Each conversation has a **Work** view, opened with **Work** in the top bar: everything its agents’ work touched, and what it took ([#132](https://github.com/HJeon139/postbox/issues/132)). It covers every session in the conversation, side and topic threads included, so you never have to ask an agent to recount what it did.

- **Files** each agent’s edits changed, each with its diff, its lines added and deleted, and where it stands in git: uncommitted, committed or pushed. Lines are counted from the diff against the file before the agents’ first change, so five edits that end where they began count as nothing. A change outside the project, or to a file that existed before and git doesn’t track, is flagged. Postbox keeps a copy of each file from before, so **Restore** can put it back.
- **Version control:** branches made, commits with their files and lines from git, and pushes.
- **Outside Postbox:** issues, pull requests and comments written with `gh` or a connector, with links.
- **Commands** exactly as they ran, with their exit, duration and all their output, background commands included.
- **Effort:** turns, wall time, tool calls, tokens and spend, by agent, with what they produced, and the turns that left nothing lasting.

It opens in the right pane, beside a thread if one is open, in a compact form: what needs review, files by where they stand, commands and how many failed, what was written outside Postbox, spend, and each turn’s line. Its full-screen icon shows all of the above over the whole window, as a thread’s does for the thread. Under each reply, a line such as “3 files +40 −12 · 2 commands · $0.31” opens the pane at that turn. It’s built from the turn’s tool calls, on Claude Code, the Agent SDK, Codex and Antigravity; Kiro agents’ work isn’t recorded yet ([#555](https://github.com/HJeon139/postbox/issues/555)). Changes a command makes, such as a formatter’s, aren’t seen. Git is only read, without its optional locks, so an agent’s own git never waits on Postbox.
