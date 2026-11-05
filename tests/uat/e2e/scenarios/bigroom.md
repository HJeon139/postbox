# Big room: reading far back while agents keep writing

- persona: A lead reading back through a long room to find an earlier decision, while two agents keep posting. Jumps by link, by “Next that needs you”, and by searching, and pages through long messages, going to the first day with Home.
- agents: researcher, critic
- seed: big-room
- seed-diagrams: 6
- measure-key-frame: on
- steps: 30
- conversation: The release, in a long room

The room is seeded with about 1,000 items, so the page holds only a window of it. Agents keep writing while you read far back. Nothing you’re reading should move unless you scroll, a jump should land on its target, and a block revised far above should come back as its one live copy at the bottom.

## Phase 1: Reading back while agents write (B1, B3)

- triggers: window-paged-back, key-frame-measured
- steps: 8

Ask @researcher and @critic each for a long write-up, one after the other. Once both have replied, press Home to go to the room’s first day, then page down slowly, and say whether what you were reading ever moved without your scrolling. Then press End.

What this phase tests: `window-paged-back` only shows that you reached the first day. The goals are that `view-moved` stays silent across Home and the pages down, while the room holds the two new replies, and that End brings the view back to following as a change of mode with your input before it. A run that fires `window-paged-back` alone isn’t a pass.

What it can’t test: paging while a reply streams. The run waits for every agent to finish before each of your steps (`settle` in `tools/uat-run.mjs`), and no step scrolls while a turn runs. `tests/browser/view-moved-stream.spec.mjs` checks the nearest case on a real page: a view that is following, or reading after a scroll up, held still while a reply streams. Paging during a stream is checked by neither until the runner can scroll mid-turn (#805).

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

## Phase 5: Diagrams far above (#701), while an agent replies (#564-b1)

- triggers: diagram-deferred, session-scoped
- steps: 4

The seeded room has six diagrams spread through it. Without scrolling, type a short message to @researcher asking for a one-line summary of the room, and say how quickly what you type appears. Then scroll up until you reach a diagram, and say whether it’s drawn. (The runner’s screenshots also scroll to each diagram after the first step; the trigger reads what the page had asked for before them. While @researcher replies, its session events reach the page, and session-scoped reads whether any of them looked through the whole page.)
