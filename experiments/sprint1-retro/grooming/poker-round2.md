# Estimation round 2 (approved scale, 27 October 2026)

A point = relative effort to the Definition of Done (cause, code and failing tests, verification incl. real-backend or remote runs, reviews). Not time, not lines. Unknowns only the work can answer raise a number; an open decision gets `?`. Points rank, they aren't agent-days.

Cards: 1, 2, 3, 5, 8, 13, `?` (can't estimate / decision open: say what you'd need), `split` (bigger than the 13 reference: say where to cut).

References (facts from GitHub):
- 1 = #460 LaTeX scan once: 4 commits, 0 reviews, no real run; one module + perf unit test.
- 3 = #430 rings still: 4 commits, 0 reviews, no real run; client CSS/JS + two browser specs.
- 5 = #445 app save receipts: 7 commits, 1 review, no real run; server, guide, intent.md, four test files.
- 8 = #449 Codex Ask me covers MCP: 13 commits, reviewed in a Postbox room, real Codex runs; a bundle of three fixes (#421 alone ~5).
- 13 = #423 agy hook approves routine calls: 7 commits, 1 review, real Antigravity turn; new approval mechanism.

Items (scope in one line):
- #468: keep a comment being typed on a review block when it re-renders
- #439: queue, not drop, a wake that needs a second card; retire a stale card; take over #326's tests
- #208: per-persona memory on every backend, as posted on #208. The person's two memory choices are still open: give `?` unless you size only the parts they don't touch, and say so
- #400: fix the publish help text, then the agy hook enforces unticked tools and "may publish"
- app-check: rebase fix/app-check (7 commits, 86 behind main), finish, PR for #37 #327 #328 #336
- #466+#458+#467: network-failure retry, recovery turn after a started tool call, agents cancel wakes by schedule ID, Kiro's plain-words error
- #472-step2: notify_agent to idle agents on catch-up, per-sender fold cap, Add card
- #469: threads stop isolating; a reply wakes the post's owner; intent.md and bring_to_conversation change
- #472-step4: mid-turn notify and wake on the universal path, states, pair-limit count, fallback
- #331: agents acknowledge with reactions or notify, not wakes: guide and checks
- #382: start_thread, its guide line, the outcome post
- #212: amend_message for an agent's own prose, marked, with the diff
- #427: queued-message mail button and dialog (branch fix/queued-message-space, 5 commits)
- #424: Enter wakes, Ctrl/Cmd+Enter notifies; scheduler decides only whether to interrupt
- #95-slice1: view_app screenshot at inline size, pinned Chromium with consent, architecture.md decision
- #464: updating Postbox doesn't strand agents on remote hosts
- #404: the three gaps after #304's security re-review
- #417: a reviewer on another host can read the app or files it's asked to review

Not in points: #470's spike (time box, one session per backend).

How to answer:
1. Write `.scratch/grooming/estimates-<your handle>.json`  as a JSON array: [{ "item": "#468", "card": 3, "driver": "one line" }, ...], one entry per item above, item names exactly as listed. `card` is a number, or "?" or "split".
2. Don't open the other estimators' files, and don't post numbers in the conversation.
3. Post only "done" in the conversation, and @-mention researcher.
