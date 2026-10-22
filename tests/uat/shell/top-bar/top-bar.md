# Top bar

![Top bar](../../screenshots/top-bar.png)

**Where:** Every view, across the top.

## Why it exists

It answers “where am I, who is here, and what needs me?” from anywhere: the path to the open conversation, the agents in it and what they’re doing, and the global actions.

## Expected functionality

- The sidebar toggle (left) hides and shows the rail; ⌘\ does the same, and the choice is remembered after a reload.
- The Postbox mark opens the places menu (see [Postbox menu](postbox-menu.md)).
- Breadcrumbs read Project › Conversation; the project crumb opens that project, and Overview is a link when you’re elsewhere.
- Each agent in the conversation has a chip: its ring, @name, what it runs with, and status word (“· idle”, “· thinking”, “· calling tools”, “· needs you”), updating live.
- What it runs with (#60): the model that answered its last turn, short (“· Opus 5.5”), then the effort (“· medium effort”). Before its first turn, the model and effort it’s set to. A model that isn’t the one set says so in words: “· Sonnet 5.5, not Opus 5.5”. An effort changed since the last turn says both: “· low effort, set to high”. A mock agent shows neither.
- An agent with blocks left open from earlier turns also shows a quiet “1 open review” button, which scrolls to the block and focuses it. Those blocks don’t make it need you (#69).
- “⋯” opens the [conversation menu](conversation-menu.md).
- “Jump to… ⌘K” opens the [command palette](../command-palette.md).
- The needs-you button counts agents waiting on you; it is disabled with “Nothing needs you” when none are, and ⌃J goes to the next one and focuses what it’s waiting on.
- The gear opens Settings.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Open “Corpus planning” (a room) from the rail.
3. Check the breadcrumbs, the two agent chips and their status words.
4. Send “@indexer index the shelf” and watch @indexer’s status word change as it works.
5. Press ⌘\ twice; reload in between and check the rail state persists.
6. Press ⌃J while something needs you.

**Pass if:** Every item above behaves as described, and status words change within a second of the agent’s state.

## Related

- [postbox menu](postbox-menu.md)
- [conversation menu](conversation-menu.md)
- [rail](../rail/rail.md)
