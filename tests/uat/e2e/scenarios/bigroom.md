# Big room: reading far back while agents keep writing

- persona: A lead reading back through a long room to find an earlier decision, while two agents keep posting. Jumps by link, by “Next that needs you”, and by searching, and scrolls up slowly through long messages.
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

Ask @researcher and @critic each for a long write-up, one after the other. While they write, scroll up slowly through the room to its first day, and say whether what you were reading ever moved without your scrolling. Then press End.

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
