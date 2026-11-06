# Pantry: what happens when someone adds an item

- **Idea:** An add passes three gates before anything is saved (the token, the route, the item’s checks), then joins a queue so writes happen one at a time, replaces the file through a temporary copy, and clears the cached list so the next read sees it.
- **For:** A developer who just joined a small project and needs to change how items are saved.
- **Question:** When someone adds an item, what happens between the request arriving and the file being saved?
- **Facts** (from the run’s `src/`, about 120 lines):
  - `server.mjs`: every request but a GET needs the token (`auth.mjs`, a timing-safe compare), or it gets 401.
  - `router.mjs`: method and path pick the handler; anything else is 404.
  - `routes/items.mjs`, `addItem`: reads the body as JSON, checks the name, a quantity above zero and the unit (g, kg, ml, l or pcs), else 400.
  - `store.mjs`, `write`: waits for the write before it, reads the file fresh, applies the change, writes `data/pantry.json.tmp`, renames it over `data/pantry.json`.
  - Then `forget('items')` clears the cached list (`cache.mjs`, 30 seconds); the reply is 201 with the new item.
  - A GET skips the token, and is served from the cache when it’s under 30 seconds old.
- **Shape:** Process with branches: a route with three exits before the save, and a queue at the save.
- **Must show:** the path of one add, with where it can be turned away; that writes wait in line; that the cached list is cleared after the save.
- **Traps:** a box per file with arrows between them, which is the code’s layout, not what happens; a sequence diagram of every call; the GET path given equal weight.
