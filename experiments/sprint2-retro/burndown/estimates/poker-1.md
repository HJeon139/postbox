# Estimation round 1 of sprint 2 (2 November 2026)

A point is relative effort to the Definition of Done (rule 26: cause, code and failing tests, verification including real-backend or remote runs, reviews). Not time, not lines. Unknowns only the work can answer raise a number; an open decision gets `?`. Points rank; they aren’t agent-days.

Cards: 1, 2, 3, 5, 8, 13, `?` (can’t estimate, or a decision is open: say what you’d need), `split` (bigger than the 13 reference: say where to cut).

References (the sprint 1 scale, `grooming/poker-round2.md` in the kit at `fce1201`):
- 1 = #460 LaTeX scan once: 4 commits, 0 reviews, no real run; one module and a perf unit test.
- 3 = #430 rings still: 4 commits, 0 reviews, no real run; client CSS/JS and two browser specs.
- 5 = #445 app save receipts: 7 commits, 1 review, no real run; server, guide, intent.md, four test files.
- 8 = #449 Codex Ask me covers MCP: 13 commits, reviewed in a Postbox room, real Codex runs; a bundle of three fixes.
- 13 = #423 agy hook approves routine calls: 7 commits, 1 review, a real Antigravity turn; a new approval mechanism.

Items (scope in one line each; grooming is researcher’s, on `main` at `46116a91`):
- #564-rest: remove a diagram’s `message` listener when its reply is replaced, not only when a later message arrives (`app/js/apps.mjs:863`); redraw a topic thread’s replies when a term it inherits from its parent is defined (`app/js/thread.mjs:365`, untested inference). Re-parsing per frame stays out: the issue measured it at about 1.1 ms.
- #544: a Kiro turn that fails on the request size limit is recognized (`server/adapters/kiro-cli.mjs:403-407`, `kiro-errors.mjs`) and the session restarts automatically with Postbox’s usual catch-up through the missing-session path (`kiro-cli.mjs:467-472`), plus the guide line; check how each other backend handles a context that’s too large and fix or file. The step-state change (`runtime.mjs:1049`) is not in this item.
- #464: a host setting with standing consent that installs this Postbox’s version on a remote host automatically and reconnects; tell “launcher missing” from “installed but couldn’t start” (`server/remote/ssh-failures.mjs:13`, `:147-148`); reviewed as a security change. Sprint 1’s re-vote for the whole issue was 8.

**Blind cards:** write `.scratch/sprint2/estimates-1-<your handle>.json` in the main checkout as `[{ "item": "#564-rest", "card": 3, "driver": "one line" }]`, without opening the others’ files, then post only “done” with its sha256. Cards that differ by more than one step get one re-vote; still apart after that, the item goes to the person as `?`.
