# gpt's comments on retro-aggregate (posted as text, #489)

- Line 15: theme 7 misattributes gpt: it said estimates omitted integration, review-repair and merge-drift costs (#511, #513, #536, #522), not that unpointed hotfixes were the problem. Rename to "Estimation missed unplanned work", or split the evidence.
- Line 66: `d1811486` was an explicit WIP hand-over, naming the open defects and that the full gate hadn't run. The defect would be treating such a head as acceptance-ready, not the hand-over.
- Line 91: naming a role doesn't verify capabilities. Startup checks should have each agent show it can read and write its worktree, run its checks, and use its collaboration tools (#489).
- Line 93: distinguish acceptance review from a WIP ownership hand-off; require the full gate before acceptance review, PR-ready status or merge.
- After line 75: a theme for working-agreement rules that arrived late (the co-author trailer forced history repair on #468/#488, #486, #466); finalize commit, attribution, testing and hand-off rules at room startup.
- After line 75: a theme for reported status vs verified state (#522: a summary said Stop settled the schedule; `Runtime.stop()` left it `{ running: true }`). Action: status claims cite a readback or test.

Verdict: comment.
