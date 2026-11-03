# Critic’s blind retrospective, sprint 2

## 1. Room setup

- **The shared checkout lagged `main` by 451 commits and held another agent’s nested worktree,** so every agent’s first gate either ran on stale code or failed on Biome’s nested config. Each of us ran the gate in our own worktree at `origin/main` instead (critic’s check in the room, `46116a91`; developer’s and researcher’s first gates exited 1 on `tester-522/biome.json`).
- **Writing a handle with the @ in prose added agents to the room by accident.** “add @tester” in a message of mine raised add-agent cards twice, and one stayed open from 18:52 UTC, holding my mentions of scrum-master, developer and claude-ssh for hours (Postbox’s “held behind … add @tester” notes). claude-ssh learned that #678 and #679 were approved only through scrum-master’s relay.
- **Running the tester’s work as my subagents, instead of a tester agent, made the review cheaper but brittle.** The #673 subagent was cut off twice when sessions restarted, and the S3a subagent finished its runs but never reported, leaving its gate killed with `Terminated: 15` (its temporary logs, read by hand).
- **The person’s standing rules made the flow clear once they were set:** label `ready for integrator` (the `pr-review-labels` choice), inline comments on PRs without a draft (`critic-inline-where`), and the UAT budget (rule 25).

## 2. Grooming, estimation and planning

- **Blind cards converged fast:** #564-rest 3/3/3, #544 5/5/5, #516-S1 5/5/5 in round 6 (`estimates-*.json`). One round was anchored when an estimator posted its number (round 5), and scrum-master voided it.
- **Designs reviewed before code paid off:** S1’s two P1s (a stateless `from` that couldn’t pin a version, and offsets that moved when a check was recorded) were fixed in revision 2 before any branch existed (`critic-design-516-r1`). S3’s P1, deleting blobs by absence, was fixed in the design, not in code (`design-516-s3-r1`, F12).
- **The person approved designs before my review twice** (`design-516-r1`, `design-516-s3-r1`), so my findings came after the approval and needed a second revision anyway.
- **Estimates didn’t price the quality bar.** S3a was carded 8 with the design approved, then took three more rounds of review: Rule 20 survivors, the quality cleanup, and the complexity rework the person asked for on #688.

## 3. Execution

- **My reviews missed code quality and time complexity, which the person then found on merged-ready PRs.** That covers the chained ternaries on #682, and the full-state scans and O(n²) `prunable` on #688. Both PRs had carried my approval and `ready for integrator`. Every one of those became a round trip.
- **Mutation runs caught real gaps every time:** #564-rest’s `seen` guard, #544’s M11 session clear, #671-a’s M8 default, #673’s (g), and S3a’s five survivors. Each ended in a test before its PR opened, under rule 20.
- **Checking the evidence found wrong claims:**
  - `$?` after a long chained command reported 0 where `git merge-tree` conflicted (claude-ssh’s correction).
  - A UAT finding of a “stale write not refused” was contradicted by the store’s `asset.version` bases.
  - A test passed on Linux only, through `/etc/hostname` (#689, `asset-tools.test.mjs:74`).
- **Waiting came from crossed messages.** Heads moved while I read them (#544: `901552db`, then `2e12b65b`, then `28ae71fb`; S3a: `494ea2e0`, then `77c75da4`, then `72841cae`, then `dbad81c8`), and approvals or requests arrived after the work they asked for was already done.
- **Machine load reached 200 to 415** and failed gates on timing tests (developer’s S3a gate). The shared locks (`with-lock.sh`) kept browser runs one at a time, but not everyone’s heavy runs.

## 4. Postbox itself

- **A held mention behind an add-agent card was invisible to the agents it was meant for, and the card stayed open after it was declined.** That made at least two hours of my approvals undelivered (Postbox’s held notes, scrum-master’s report, the 18:52 card).
- **Subagents of a Claude Code session don’t survive a session restart, and leave no completion record** (the task notices for #673's and S3a's runs). A role that depends on them needs its runs written to logs it can recover from.
- **A remote agent can’t read the laptop’s files** (#417), so claude-ssh pasted evidence and couldn’t read the design files, and scrum-master relayed design text by hand.
- **Mermaid nodes labeled like numbered steps render “Unsupported markdown: list”** (#684, found by the #678 UAT run).
- **The UAT tester can’t tell glossary links from plain text in full-screen view,** so #678’s run couldn’t confirm its pass condition (`uat678` report).

## 5. First three changes for next sprint

1. **Critic runs a quality and complexity pass before approving any head:** `noNestedTernary` on the changed files (#685 makes it a gate check), dense lines, one rule decided in two places, and scans of the whole state per request. No approval or label until it’s clean. That would have saved the round trips on #682 and #688.
2. **Make the tester’s runs survive a restart:** each run writes its commands and exit codes to a log in its temp folder as it goes, with a time limit, so a stalled or cut-off subagent loses nothing. Or bring the tester back as an agent with its own session.
3. **Stop accidental mentions and their held messages:** write handles without the @ unless the agent must act, and file the Postbox defect where a declined add-agent card kept holding mentions.
