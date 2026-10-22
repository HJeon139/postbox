# Working row

![Working row](../../screenshots/working-row.png)

**Where:** At the end of the conversation, while an agent is thinking or calling tools.

## Why it exists

A moving ring alone doesn’t say what the agent is doing. This row says it in a line, while it happens, and goes away when it’s done.

## Expected functionality

- One row per agent in the conversation that’s thinking or calling tools: its ring, name, and state, plus the current step while it calls a tool.
- Below that, a glimpse of its latest thinking (real agents send summarized thinking), or of a subagent’s progress, updated a few times a second.
- The row goes away while the agent writes its reply, since the reply shows then, and when the turn ends.
- The rows sit in the message column: the ring lines up with the @name of the messages above, at 1280 px with and without the thread panel. A long step stays on one line and ends with an ellipsis inside the column (#83).
- The overview card’s Current step shows the same glimpse.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180 --speed 3`) and open <http://127.0.0.1:4180/> while it plays.
2. Scene 10b (“Tidy the workspace”): watch the end of the conversation, and the agent’s card on the overview.
3. Run Postbox with real agents and ask for something that takes thought, such as “Plan how you’d split the corpus into chapters, then do it.”
4. Run `node tools/check-transcript.mjs`: it measures the row’s left edge against the messages’ and checks that a long step truncates, with and without the panel.

**Pass if:**
- The row appears within a second of sending, and shows readable thinking.
- It names the step while a tool runs.
- It disappears once the reply starts streaming, and after the turn.
- It starts at the same left edge as the messages, not at the edge of the pane.

## Related

- [Activity line](activity-line.md)
- [Agent reply](agent-reply.md)
- [Following the newest message](following.md)
