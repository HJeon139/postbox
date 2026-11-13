# Malformed app: refused before it’s shown

- persona: A small-business owner who asked for a quick chart of their weekly sales, and who notices anything broken on screen. Reads replies quickly. Writes short messages.
- agents: developer
- permission_modes: developer=auto
- project: Sales chart
- conversation: Weekly sales

A targeted scenario for #1319, Claude Code only, with @developer on this computer in Auto. An agent’s malformed app or block used to be posted anyway, as a broken card showing its fallback text and a collapsed “Show the raw block”, and the agent retried beside it, often under a new id, so each try left another. Now Postbox refuses it before anything is shown, and the reply says what to fix with a valid example. Real agents send malformed calls often (26 refusals in the UAT runs from 26 October to 13 November 2026) but not on cue, so each phase asks for one on purpose, then the fix. Watch for any card with “Show the raw block”, plain fallback text where a chart or form should be, two copies of the same app or form, and an agent that says its call went through when it didn’t.

`node tools/uat-run.mjs --scenario malformedapp --file no`.

## Phase 1: An app with a bad permission, then fixed

- triggers: app-refused-then-shown
- steps: 5

Ask @developer to show a small app with show_app: a line chart of these weekly sales, Monday 12, Tuesday 9, Wednesday 15, Thursday 7, Friday 18, as dots joined by a line. Tell it to test Postbox’s checks first: its first show_app call must list one permission that isn’t a tool name, “Read Files”, with a space and capitals. Once Postbox refuses it, it should fix the call from what the refusal says, and show the app again with the same id. Then say whether you saw a broken card, raw JSON or fallback text at any point, and how many copies of the chart are in the conversation.

## Phase 2: A form with string options, then fixed

- triggers: block-refused-then-shown
- steps: 5

Ask @developer to ask you which day to promote, with show_block and a form that has one select. Tell it to test Postbox’s checks again: its first try must give the select’s options as plain strings, such as ["Monday", "Friday"], and leave out fallback. Once Postbox refuses it, it should fix the block from the example in the refusal and show it again with the same id. Answer the form when it appears. Then say whether you saw a broken card or raw JSON at any point, and how many forms are in the conversation.
