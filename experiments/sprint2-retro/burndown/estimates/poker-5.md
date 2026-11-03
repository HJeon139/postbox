# Estimation round 5 of sprint 2 (2 November 2026): #516 S1

Same scale and references as `poker-1.md`. The person approved the #516 design, revision 1 (`design-516-r1`; copy in `design-516.md`).

Item:
- #516-S1 (#417, AP-1’s tool half): `read_message` on an app returns its code in 40,000-character parts, with an optional `version`; the first part fixes the version, so an `update_app` between parts can’t mix versions; an older version says its check isn’t kept; on a host it reads through Postbox, and the offline answer says the code needs Postbox connected. Files and acceptance: `design-516.md`, “The first slice to build: S1”. It shares `shared/mcp-tools.mjs` with the other room’s #639: it merges after #639, or is checked with `git merge-tree` against #639’s head before review.

**Blind cards:** write `.scratch/sprint2/estimates-5-<your handle>.json` as before, without opening the others’ files, then post only “done” with its sha256.
