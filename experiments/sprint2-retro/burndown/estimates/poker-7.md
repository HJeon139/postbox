# Estimation round 7 of sprint 2 (2 November 2026): #673

Same scale and references as `poker-1.md`. The person’s decisions (block `d673-switch`): options switch to panels when any label would wrap at the block’s width (measured, not a fixed length); the catalog’s `display` option is removed from the catalog and the guide.

Item:
- #673: a choice block measures its options at its own width; when any label would wrap, every option shows as a panel (full width, one per row, left-aligned, corners for a multiline box per #199), else pills as today; panels keep radio or checkbox semantics, the chosen state, keys 1–9, focus across a re-render, and “Other”; it re-measures when the width changes; `display` comes out of `shared/catalog.mjs:64`, the guide (`server/adapters/guide.mjs:172`) and the design docs; a browser spec at 375 and 1280 px fails on `main` first. Files: `app/js/blocks.mjs` (155–250), `app/workbench.css`, `shared/catalog.mjs`, `server/adapters/guide.mjs`, a new browser spec. The other room’s #656 changes `app/workbench.css`: merge after it, or check with `git merge-tree`.

**Blind cards:** write `.scratch/sprint2/estimates-7-<your handle>.json`, without opening the others’ files, then post only “done” with its sha256.
