# Top bar

![Top bar](../../screenshots/top-bar.png)

**Where:** Every view, across the top.

## Why it exists

It answers “where am I, and what needs me?” from anywhere: the path to the open conversation and the global actions. Who is here, what each agent is doing and what it runs with are in the sidebar’s [Agents section](../rail/agents-section.md) (#105), so the title and the project have room. The top bar had a ring for each agent too, which only repeated the sidebar’s (#320).

## Expected functionality

- The sidebar toggle (left) hides and shows the rail; ⌘\ does the same, and the choice is remembered after a reload.
- The Postbox mark opens the places menu (see [Postbox menu](postbox-menu.md)).
- Breadcrumbs read Project › Conversation; the project crumb opens that project.
- No agent rings (#320): each agent’s ring and its [quick panel](../rail/agents-section.md) are in the sidebar’s Agents section, and the conversation’s ⋯ menu names each agent, with what it runs with, at every width.
- With two agents in a room at 1280 px, the conversation’s title and the project show in full (#105).
- At any width, nothing in the top bar overflows or runs under anything else (#72). When it doesn’t fit, it drops, in order: the project above the conversation’s title, then the demo banner’s sentence (it folds to “Demo”). The title keeps about 100 px before anything drops for it. Postbox measures what fits, so it depends on the window’s width, not on a fixed breakpoint, and everything comes back when there’s room again.
- “⋯” opens the [conversation menu](conversation-menu.md).
- In a conversation, “Work”, with a page icon, opens and closes the conversation’s Work in the right pane, and shows pressed while it’s open (#183). On a phone only its icon shows, and a screen reader still reads “Work”.
- “Jump to… ⌘K” opens the [command palette](../command-palette.md).
- The needs-you button counts agents waiting on you, a refused step and a tool request too; it is disabled with “Nothing needs you” when none are. It and ⌃J go first to an agent in the open conversation (or its side and topic threads) that needs you, else to the one that has waited longest; pressed again, they move on through the rest, oldest first, so each one comes up in turn. Each lands on the ask itself, scrolled into view, focused and outlined for a moment (#285).
- The gear opens Settings.
- Under `--demo`, “Demo mode: scripted agents” sits beside “Jump to…” on every view: a project, Threads and a conversation (#12). It can’t be closed; where room is short it folds to “Demo”, and a screen reader still reads the whole sentence. It isn’t a live region. Without `--demo` it isn’t there.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Open “Corpus planning” (a room) from the rail.
3. Check the breadcrumbs: Book corpus › Corpus planning, in full, and no agent rings.
4. Open ⋯: it names both agents, with what each runs with.
5. Press ⌘\ twice; reload in between and check the rail state persists.
6. Press ⌃J while two agents in different conversations need you, from a conversation whose agent needs you, then again.
7. Add two more agents to “Corpus planning” (⋯ › Add an agent…), so it has four. Narrow the window from full width to its narrowest, then widen it again.

**Pass if:** Every item above behaves as described. The demo banner shows on every view. In step 7, the top bar never overflows, the parts drop and come back in the order above, and ⋯ lists each agent’s backend, model, effort and state at every width. `npx playwright test header work-pane needs-nav` passes.

## Related

- [postbox menu](postbox-menu.md)
- [conversation menu](conversation-menu.md)
- [rail](../rail/rail.md)
- [agents section and quick panel](../rail/agents-section.md)
