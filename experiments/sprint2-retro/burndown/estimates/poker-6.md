# Estimation round 6 of sprint 2 (2 November 2026): #516 S1, revision 2

Round 5 is void: its scope changed with revision 2, and one card was disclosed in the room. Its files are in `void-round5/`, unread.

Same scale and references as `poker-1.md`.

Item:
- #516-S1 (#417, AP-1’s tool half), as in `design-516.md` revision 2 (sha256 `99dea57d…`), “The first slice to build: S1”: `read_message` on an app returns its code in 40,000-character parts; every “reads on” line names `version`; `from` counts over the code alone and every part repeats the head line outside the count; an older version says its check isn’t kept; a check recorded between parts doesn’t move parts 2 and 3; on a host it reads through Postbox, and the offline sentence is written into the app item’s snapshot `text` by the laptop (`server/remote/turns-snapshot.mjs`), with no change to the host program. Tests in a new file, `tests/remote-read-app.test.mjs`. It shares only `shared/mcp-tools.mjs` with the other room’s #639.

**Blind cards:** write `.scratch/sprint2/estimates-6-<your handle>.json`, without opening the others’ files, then post only “done” with its sha256 — nothing about the card itself.
