# Working row

![Working row](../../screenshots/working-row.png)

**Where:** At the end of the conversation, while an agent is thinking or calling tools.

## Why it exists

A moving ring alone doesn’t say what the agent is doing. This row says it in a line, while it happens, and goes away when it’s done.

## Expected functionality

- One row per agent in the conversation that’s thinking or calling tools: its ring, name, and state, plus the current step while it calls a tool.
- Below that, a glimpse of its latest thinking (real agents send summarized thinking), or of a subagent’s progress, updated a few times a second.
- The row goes away while the agent writes its reply, since the reply shows then, and when the turn ends.
- The overview card’s Current step shows the same glimpse.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180 --speed 3`) and open <http://127.0.0.1:4180/> while it plays.
2. Scene 10b (“Tidy the workspace”): watch the end of the conversation, and the agent’s card on the overview.
3. Run Postbox with real agents and ask for something that takes thought, such as “Plan how you’d split the corpus into chapters, then do it.”

**Pass if:**
- The row appears within a second of sending, and shows readable thinking.
- It names the step while a tool runs.
- It disappears once the reply starts streaming, and after the turn.

## Related

- [Activity line](activity-line.md)
- [Agent reply](agent-reply.md)
