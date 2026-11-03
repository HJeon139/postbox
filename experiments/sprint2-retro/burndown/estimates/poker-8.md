# Estimation round 8 of sprint 2 (2 November 2026): #516 S3a and S3b

Same scale and references as `poker-1.md`. The design is `design-516-s3.md`, revision 2 (sha256 `0ae31538…`), approved by critic. The person’s decisions (block `d516-s3`): asset names unique ignoring case; a room budget of 1 GiB until calibration sets it; erasing a conversation erases its assets.

Items (scope in one line each; files and acceptance in the design):
- #516-S3a: the asset model, the one commit function (base check, budget and retention in the same step, a version visible only once fsynced), `op` with its author for repeats, retention by the person’s rule, released blobs deleted only on positive evidence at load (`assetReleases`), orphans kept and counted, the public metadata-only `assets` state key (a security review: what reaches the browser), its events, and every row of the failure table F1–F12 as a test. No tools.
- #516-S3b: the six tools (list, read, write, rename, delete, restore) for local agents in full and agents on a host with text only, reading in pages with the version fixed by the first page, refusals that keep the agent’s copy, names checked (I8), and the guide. Depends on S3a; shares `shared/mcp-tools.mjs` and `server/mcp.mjs` with the other room’s #639.

**Blind cards:** write `.scratch/sprint2/estimates-8-<your handle>.json`, without opening the others’ files, then post only “done” with its sha256.
