# Big room: reading far back while agents keep writing

- persona: A lead reading back through a long room to find an earlier decision, while two agents keep posting. Jumps by link, by “Next that needs you”, and by searching, and pages through long messages, going to the first day with Home.
- agents: researcher, critic
- seed: big-room
- seed-diagrams: 6
- measure-key-frame: on
- steps: 30
- conversation: The release, in a long room

The room is seeded with about 1,000 items, so the page holds only a window of it. Agents keep writing while you read far back. Nothing you’re reading should move unless you scroll, a jump should land on its target, and a block revised far above should come back as its one live copy at the bottom. The checks run every step, as in every scenario; once the room passes 1,000 items, `rows-skipped` fires if the browser lays out most of them (#712a).

## Phase 1: Reading back while agents write (B1, B3)

- triggers: window-paged-back, key-frame-measured
- steps: 8

In one message, ask @researcher and @critic each for a long write-up from what they already know, not from this room, whose log holds no results to write up: for example, @researcher on how a write-ahead log keeps a database safe through a crash, and @critic on what makes a code review useful. Ask each to answer you only, without naming the other, so neither wakes the other when they’ve finished. Both then write at once, at length. Give that message an interrupt that pages while they write, `{after: 5, do: scroll, moves: [up, up, up, down, end]}`: three pages back, one forward, then End. After each move you hear where the view was. Say whether what you were reading moved while the replies streamed in below it. Once both have replied, press Home to go to the room’s first day, then page down slowly, and say whether what you were reading ever moved without your scrolling. Then press End.

What this phase tests: `window-paged-back` only shows that you reached the first day. The goal is that `view-moved` stays silent across the pages taken while the two replies stream, and across Home and the pages down once they’ve finished. The interrupt takes two view samples after each of its moves, a second apart, while the turn runs (#805). Each of your moves is an input, so the pair rule excuses the pair it comes between; but each move’s own two samples have no input between them, so `view-moved` compares them while the replies stream: a reading view must hold its anchor while a reply grows below it, the view End brings back must keep following without drifting from the end, and each sample’s published offset must match where its anchor is. The sample after End and the next step’s have no input between, unless the runner clicked, so that pair checks the view kept following while the replies finished. A run whose report says `view-moved` checked no pair of steps has checked only the rule within one sample. No check asserts that End brings the view back to following, though the interrupt says what the view was after it. A run that fires `window-paged-back` alone isn’t a pass, nor is one whose interrupt said the agents finished before it scrolled (its `findings.json` probes list each interrupt, and `inputs` each scroll, by step).

Why the write-ups come from what the agents know, each to you alone: a run on 27 November asked for a write-up of the release, and both agents said the log held nothing to write up, in short replies, then traded “nothing to add” messages that named each other, each waking the other, 12 turns in 90 seconds, until the run’s turn bound stopped it mid-step.

`tests/browser/uat-scroll-mid-turn.spec.mjs` drives the same interrupt on a real page against a reply that streams until the interrupt has returned, and `tests/browser/view-moved-stream.spec.mjs` holds a following view, or a reading one, still while a reply streams.

## Phase 2: Jumps (B2, B3)

- triggers: jump-outside-window, needs-far-back
- steps: 8

Open the link to the seeded room’s first decision (the run gives it to you). Then ask @critic to put a choice to you, and before answering, scroll far up and press “Next that needs you”. Say where each one landed.

## Phase 3: A block revised far above (B2)

- triggers: move-from-unloaded
- steps: 6

The seeded room holds a review block from @researcher near its start. Ask @researcher to revise that block. Without scrolling up, say where the new revision appears and what is left where the old one was.

## Phase 4: Search and switching (B3)

- triggers: search-outside-window, switch-conversations
- steps: 8

Search for a word that only appears in the seeded room’s first day, and open the result. Switch to another conversation and back while @critic is writing, and say whether anything it wrote is missing or shown twice.

## Phase 5: Diagrams far above (#701, #712a), while an agent replies (#564-b1)

- triggers: diagram-deferred, session-scoped, items-skipped
- steps: 4

The seeded room has six diagrams spread through it. Without scrolling, type a short message to @researcher asking for a one-line summary of the room, and say how quickly what you type appears. Then scroll up until you reach a diagram, and say whether it’s drawn. (The runner’s screenshots also scroll to each diagram after the first step; the trigger reads what the page had asked for before them. While @researcher replies, its session events reach the page, and session-scoped reads whether any of them looked through the whole page.)
