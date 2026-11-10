# Sprint 4: close, retrospective and board (6–10 November 2026)

A work-in-progress folder, not meant to merge, in the shape of `wip/sprint1-retro`, `wip/sprint2-retro` and `wip/sprint3-retro`. It holds sprint 4's state at close, the close sweep, the room's blind retrospective and the sprint board. Host names, accounts and local paths are left out.

The room: `scrum-master`, `critic`, `researcher` and `tester` on the person's computer; `lead-state`, `lead-security`, `lead-cards`, `lead-delivery`, `lead-host-install`, `lead-measure` and `lead-transcript` on the x86 build host; and `lead-sweep` on the aarch64 host. The person was the only reviewer and merger. The sprint ended early, on 10 November, when Claude Code's usage block (a 403) and two out-of-memory crashes (#1210, #1213) stopped the room. Nine agents moved to Kiro or Codex for the close.

## Start here

1. `state-at-close.md`: the open PRs in merge order, the branches archived at the close, the decisions the person took, and what carries into sprint 5.
2. `retro/aggregate.md`: what the twelve agents said, by theme, with who raised each and the evidence, and eight ranked actions for sprint 5. The person approved it on 10 November 2026.
3. `apps/board.html`: the sprint board, as it last stood, with its data inline.

## The records

- `retro/PROMPT.md`: the five questions and the blind rules. It's sprint 1's prompt, and each agent read it as sprint 4.
- `retro/<handle>.md`: the twelve blind answers, each written before its author opened any other. They're byte-for-byte the room's assets.
- `pr-check.json`: critic's independent check of the 24 PRs open at about 17:40 UTC on 10 November, with each head's CI, review and merge state.
- `close-sweep.md`: lead-sweep's recheck, on a pinned `main`, of the 25 open issues that sprint 4's PRs name. The person approved its comments; 24 are posted, and #983's waits for one UAT run.

## What the room shipped

174 PRs merged between 6 November, 07:40 UTC and 10 November, 19:34 UTC: 109 fixes, 27 features, 20 tests, 9 docs, 8 performance and 1 CI. Every one is on `main`: `git merge-base --is-ancestor` held for each merge commit against `origin/main` at `7163785d`. Their bodies close 143 issues with `Fixes`. 15 PRs were open when the board was read; the board lists each, with its head, CI and owner.

Ownership comes from the agents' own reports, since every agent shares one GitHub account. It's known for 78 of the 174 merged PRs.
