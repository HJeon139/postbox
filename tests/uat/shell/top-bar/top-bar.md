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
- What it runs with (#60): the model that answered its last turn, short (“· Opus 5.5”), then the effort (“· medium effort”). Before its first turn, the model and effort it’s set to. A model that isn’t the one set says so in words: “· Sonnet 5.5, not Opus 5.5”. An effort changed since the last turn says both: “· low effort, set to high”. A mock agent shows neither, and says “mock” after its name instead (#12).
- At any width, nothing in the top bar overflows or runs under anything else, and every agent’s ring shows (#72). When the chips don’t fit, they drop, in order: the status words, the models, the project above the conversation’s title (and the demo banner folds to “Demo”), the efforts, the open-blocks buttons, then the names, leaving the rings. The title keeps about 100 px before a chip drops anything for it. Postbox measures what fits, so it depends on the window’s width and on how many agents there are and what their chips say, not on a fixed breakpoint; a chip whose words change refits at once, and words come back when there’s room again. What a chip drops stays in the agent’s overview card and in the conversation’s ⋯ menu, as text, and each ring’s label reads the agent’s name and state.
- An agent with blocks left open from earlier turns also shows a quiet “1 open review” button, which scrolls to the block and focuses it. Those blocks don’t make it need you (#69).
- “⋯” opens the [conversation menu](conversation-menu.md).
- “Jump to… ⌘K” opens the [command palette](../command-palette.md).
- The needs-you button counts agents waiting on you; it is disabled with “Nothing needs you” when none are, and ⌃J goes to the next one and focuses what it’s waiting on.
- The gear opens Settings.
- Under `--demo`, “Demo mode: scripted agents” sits beside “Jump to…” on every view: overview, project, Threads, conversation and Archived (#12). It can’t be closed; where room is short it folds to “Demo”, and a screen reader still reads the whole sentence. It isn’t a live region. Without `--demo` it isn’t there.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Open “Corpus planning” (a room) from the rail.
3. Check the breadcrumbs, the two agent chips and their status words.
4. Send “@indexer index the shelf” and watch @indexer’s status word change as it works.
5. Press ⌘\ twice; reload in between and check the rail state persists.
6. Press ⌃J while something needs you.
7. Add two more agents to “Corpus planning” (⋯ › Add an agent…), so it has four. Narrow the window from full width to its narrowest, then widen it again.

**Pass if:** Every item above behaves as described, and status words change within a second of the agent’s state. The demo’s agents all say “mock”, and the demo banner shows on every view. In step 7, the top bar never overflows, the rings always show, the parts drop and come back in the order above, and ⋯ lists each agent’s backend, model, effort and state at every width.

## Related

- [postbox menu](postbox-menu.md)
- [conversation menu](conversation-menu.md)
- [rail](../rail/rail.md)
