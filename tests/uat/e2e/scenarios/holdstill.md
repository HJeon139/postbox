# Hold still: reading and clicking while agents work

- persona: A developer who reads back through a busy room while three agents keep working in it, and answers an older question once they’ve read it. Clicks quickly. Writes short messages.
- agents: researcher, developer, critic
- project: Word counts
- conversation: Reading while they work
- steps: 10

A targeted scenario for #1326, Claude Code only. The person read mid-room, an agent’s update moved the page, and their click landed on something else. Agents stream replies, update review blocks and apps, and their apps and pictures grow, above the view and inside it. Reading, the line you read and the button you point at must stay where they were; following the newest message, new replies still come into view, but never move a button the pointer moved onto or a click already pressed. The browser spec `tests/browser/hold-still.spec.mjs` decides the fix with a scripted backend; this run confirms it with real agents, so run it only when that spec can’t reproduce what a person saw.

`node tools/uat-run.mjs --scenario holdstill --max-cost 2 --budget 2 --file no`.

## Phase 1: Blocks to read back to

Ask @developer to show a small app that lists the words of a short sentence one per row, then adds a row every second for twenty seconds. Ask @critic to put a draft of about fifteen lines up for you to review, and to ask you, with a choice, which of two file names to use. Ask @researcher to write a long reply, about thirty paragraphs, on how word counts differ between tools. Wait for them to finish, but don’t answer the choice yet.

## Phase 2: Reading back while they work

Send a message asking @developer to update its app to show forty rows, @critic to revise its draft with five more lines, and @researcher to write another long reply. Give it an interrupt `{after: 8, do: look}`, and before it fires, scroll up (`scroll {by: up}`, twice) so the choice is in view. In the look, and in the screenshot after, say whether what you were reading stayed where it was while they worked: did the choice, or the text around it, move while you weren’t scrolling? Then answer the choice with the first file name, and say whether the option you clicked is the one that shows as chosen.

## Phase 3: Following, and clicking as a reply arrives

Scroll to the end (`scroll {by: end}`). Ask @critic for one more choice between two words, and once it shows, ask @researcher for a short reply. Answer @critic’s choice while @researcher’s reply comes in, with an interrupt `{after: 3, do: answer}`. Say whether the option you picked is the one that shows as chosen, and whether the view then went on to the newest reply without you scrolling.
