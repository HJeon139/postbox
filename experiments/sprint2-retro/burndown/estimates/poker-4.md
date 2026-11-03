# Estimation round 4 of sprint 2 (2 November 2026): #671-a

Same scale and references as `poker-1.md`. The person chose the split in `d671-mechanism`.

Item:
- #671-a: an attachment’s line in an agent’s history, catch-up, topic-thread opener and `read_message` / `read_conversation` gives local agents a way to open it (its path, as `formatBody` already does for the addressed agent at `server/adapters/guide.mjs:280-284`), not only its name (`server/runtime.mjs:1748`, `:1774`, `server/read-message.mjs:33`). Agents on a remote host keep the name only, and the line says how to ask for it, until #671-b. `runtime.mjs` is past its size default, so this may need a move of `describeItem` into its own module first, as its own commit; it merges after the other room’s #633 and #639, or is checked with `git merge-tree` against both.

**Blind cards:** write `.scratch/sprint2/estimates-4-<your handle>.json` as before, without opening the others’ files, then post only “done” with its sha256.
