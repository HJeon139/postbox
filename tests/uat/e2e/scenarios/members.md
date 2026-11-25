# Members: bring an agent into a conversation, and take it out

- persona: A developer working with one agent who wants a second opinion partway through, then goes back to working with the one. Writes short messages, and sends them exactly as this scenario words them.
- agents: developer
- project: Notes
- conversation: A second opinion
- steps: 8

A targeted scenario for #1735, Claude Code only. A conversation’s agents are added and removed in one place, the Members list of the room’s form in the main menu, which the Agents heading’s button opens. The `members` action does that through the page. Each phase names a trigger read from what the action recorded, so a run that never changed the members is a gap in coverage.

`node tools/uat-run.mjs --scenario members --max-turns 20 --budget 2 --max-cost 6 --file no`.

## Phase 1: Add an agent

- triggers: member-added-in-menu
- steps: 4

Send this, exactly: “@developer in one sentence, what is a slug?” When it has answered, use the `members` action to add critic. Read the Agents section in the sidebar and say whether it lists both agents, and whether the conversation has a line saying critic joined.

Then send this, exactly: “@critic in one sentence, is that right?”

Pass if @critic answers, and its answer shows it read what @developer said: an agent brought into a conversation knows what was discussed.

## Phase 2: Remove it

- triggers: member-removed-in-menu
- steps: 4

Use the `members` action to remove critic. Read the Agents section and say whether it lists only developer. Then send this, exactly, with no handle in it: “Thanks. One more: what’s a good slug for ‘Hello, World’?”

Pass if @developer answers and @critic doesn’t. Say whether Settings › Personas still lists critic: removing an agent from a conversation keeps its persona.
