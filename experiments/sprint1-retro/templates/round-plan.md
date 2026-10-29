# Round <n> (approved <date>), <start>–<end> UTC

Timebox: <hours> for building and internal review. PRs, CI and the person’s GitHub review follow, in the review slot below.

| Item | Points | Author | Branch / worktree | Files it changes | Merge order | Validation |
|---|---|---|---|---|---|---|
| #<issue> <one line> | <card> | <agent> | `fix/<issue>-<slug>`, its own worktree | <paths> | <1, 2, …> | critic, tester |

Items that share a file are ordered in the merge-order column, or combined into one item (rule 16).

**Marks (UTC):** claimed by +0:15; a branch with a test that fails on `main` by +1:00; ready for review (pushed, its own full gate, `lint-commits`, `biome check`, both browser runs for a visible change) by <mark>, else cut to the next round; critic and tester approve by <mark>; integrator checkpoint with the person by <mark>; merged on the integration branch and gated by <end>.

**Review slot:** the person reviews PRs at <time>; at most 4 PRs wait on the person at once (rule 17).

**Authorized without asking:** claiming the issue (assign yourself, one-line comment) and pushing your own branch. Every other GitHub write is drafted first (rule 10).

**Decisions settled before building:** <choice block ids and answers> (rule 15).

**If you finish early:** <queue, each with an owner>.

**Rules:** `working-agreement-sprint2.md`.
