# Estimation round 2 of sprint 2 (2 November 2026): splitting #464

Round 1’s cards (`estimates-1-*.json`, hashes matched what each estimator posted):

| Item | critic | developer | researcher | Result |
|---|---|---|---|---|
| #564-rest | 3 | 3 | 3 | 3 |
| #544 | 5 | 5 | 5 | 5 |
| #464 | 13 | 13 | 8 | 13 (median; 8 and 13 are one step apart, so no re-vote) |

Rule 13 says anything at 13 is split. Same scale and references as `poker-1.md`.

Items (scope in one line each):
- #464-a: tell “launcher missing” (this Postbox’s version isn’t installed on the host) from “installed but couldn’t start” as two failure classes in `server/remote/ssh-failures.mjs`, with a recorded host case for each, each with the message that says what to do; no install, no new setting.
- #464-b: a host setting with standing consent (stored, shown in the host’s settings, off by default) that, on “launcher missing” from #464-a, installs this Postbox’s version with the existing verified install (`server/remote/install*.mjs`) and reconnects, at most once per version; reviewed as a security change, with a real run across a version bump on a remote host. Depends on #464-a.

If you’d cut it elsewhere, give `split` for the item and say where in the driver.

**Blind cards:** write `.scratch/sprint2/estimates-2-<your handle>.json` as before, without opening the others’ files, then post only “done” with its sha256.
