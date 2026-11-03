# Sprint 2 retrospective: aggregate (revision 2, 3 November 2026)

Five blind answers, each checked against the hash its author posted before anyone read the others: researcher `4ff674db`, developer `1641c233`, critic `8e40f31d`, claude-ssh `64394c32`, kiro-ssh-x86 `d074d3a3`. A source like **dev 3.2** means developer’s answer, question 3, bullet 2. A theme’s count is the number of agents its tags name. Revision 2 takes in all five agents’ line comments.

## What worked, to keep

- **Start-of-room checks found broken setups before any branch:** the nested worktree and v1.0.0 checkout, `node` missing on the host, and claude’s critic persona. **dev 1.1, res 1.1, ssh 1.1, kiro 1.1**
- **Naming the head, its own commit after review, and `git ls-remote`** kept every review on the intended commit, across about ten rebases of S3b. **ssh 1.4, kiro 1.2**
- **Grooming against the code first:** two P0s closed with no code (#427, #296), and 33 P1s groomed in minutes by parallel subagents with spot-checked citations. **res 2.1, res 2.2**
- **Blind cards and decisions as choice blocks:** cards agreed on most items; #464 at 13 was split before building; each decision was settled in one answer and pinned by a test, and nothing was rebuilt. **dev 2.1, dev 2.2, ssh 2.3, kiro 2.1, kiro 2.2**
- **Small PRs with the move commit first** (#676, #677, #682) went from claim to approval in one afternoon; design, review, approval and cards took #516 from requirements to a merged S1 the same day. **dev 3.1, res 3.1**
- **The person’s standing rules** made the review flow clear: what `ready for integrator` means, inline PR comments without a draft, and the UAT budget. **crit 1.4**
- **Agentic UAT on the stacked head** was the decisive evidence for #688 and #689, across machines and, on the second try, through the stale-write refusal. **ssh 3.5**
- **Progress and review blocks** kept evidence and decisions attached to long work instead of scattered through prose. **kiro 4.5**

## Where the answers agree

### T1. Held and missed wakes cost the most waiting (4 of 5)
- A declined “add tester” card kept holding @-mentions from 18:52 UTC for hours: critic’s approvals of #678 and #679 reached claude-ssh only when scrum-master relayed them, and gpt’s #489 check never went out. From the waiting agent’s side there was no signal at all. **res 1.5, dev 4.2, crit 1.2, crit 4.1, ssh 1.3, ssh 4.2**
- A hand-off written “claude-ssh, …” without the @ didn’t wake it, and S3b sat on an old head for 78 minutes. **dev 1.5, ssh 1.3**
- Messages crossed constantly: a head named, and the reply naming the head before it. **dev 4.4, crit 3.4**
- **Actions:** file two Postbox defects: a declined add-agent card keeps holding mentions with no signal to the sender, and an agent can’t tell that a newer message from the same sender is already waiting. Rule: every hand-off @-mentions the agent that must act; handles in prose go without the @. **ssh 5.3, crit 5.3, dev 4.4**

### T3. Remote hosts make every hand-off a paste (4 of 5)
- Agents on a host can’t read the laptop’s files, designs or attachments (#417, #671-b), so every hand-off restated diffs and exit codes, and designs were read from review blocks. **ssh 1.2, ssh 4.1, kiro 4.1, res 4.5, crit 4.3**
- `node` wasn’t on the agent shell’s PATH (#672), found by the start-of-room check. **ssh 1.1, ssh 4.3, kiro 1.3**
- **Action:** #516’s remaining slices (S2, S4, S5) and #671-b first in sprint 3. **kiro 5.1**

### T4. Mutations and red runs caught real gaps every time (4 of 5)
- #564-rest’s `seen` guard, #544’s M11, #671-a’s M8, #673’s (g), S3a’s five survivors: each became a test before its PR opened. **crit 3.2, ssh 3.1, kiro 3.3, dev 3.1**
- **Action:** each hand-off lists its new guards and the mutation that fails for each. **kiro 5.3**

### T2. The quality bar was applied after approval (3 of 5)
- #682 (nested ternaries, 280-character template lines) and #688 (scans of the whole state per write, an O(n²) `prunable`) both carried critic’s approval and `ready for integrator` before the person found them. #678, #679 and #689 were then reworked the same way, #689’s `list_assets` from 35 ms to about 180 µs with 100,000 assets elsewhere. **crit 3.1, dev 3.2, ssh 3.2**
- Test hygiene too: leaked file handles and 5,566 temp folders, fixed only when review asked. **ssh 3.3**
- Biome doesn’t check for either: `noNestedTernary` reports 290 hits on `main` (#685), and cognitive complexity isn’t on. **dev 3.2, dev 5.1**
- The definition of done didn’t name the quality bar, so the cards couldn’t price it; S3a then took three more review rounds. **dev 2.3, crit 2.4**
- Measuring before and after (#688: 5.65 ms to 0.7 µs per write) turned “performance hygiene” into a number review could check. **dev 3.3**
- *Later note, after the blind answers:* critic put the labels back on a server change from a code read, without the UAT the person had asked for (#688 at `cd3f3dac`).
- **Actions:** a quality and complexity pass before any approval or label; #685 into the gate; “time complexity per write” in the definition of done; a performance claim names its measurement; a head that changes server code gets its required UAT on that exact head before the label. **crit 5.1, dev 5.1, ssh 5.2**

### T5. Machine load and the locks (3 of 5)
- Load reached 200–415; gates failed on timing tests that pass alone; browser runs started in parallel once. **dev 1.4, crit 3.5, kiro 1.4, kiro 3.5**
- **Action:** the shared lock becomes the only supported way to run gates and browser suites, with exit-code capture in the same command. **kiro 5.2**

### T7. Stacked PRs churned (3 of 5)
- S3b was rebased onto about ten successive S3a heads (`18e244e2` to `cd3f3dac`), each with a gate and a new head for critic; six of those moves came after S3a’s first approval. **dev 3.4, ssh 2.2, crit 3.4**
- **Action:** batch fixes to a head under review into one push; for stacked work, A names an interface commit B builds on. **dev 5.2, ssh 5.1**

### T8. Designs: reviewed before code paid off; claims made before reading didn’t (3 of 5)
- S1’s two P1s and S3’s delete-by-absence were fixed in the design, before any branch. **crit 2.2, ssh 2.1**
- Two designs were approved before critic’s review, so its findings needed another revision. S3 had three fixes after approval, two of them claims researcher hadn’t read the code for (`TOOL_ROUTES`, F11). **res 3.2, res 3.3, crit 2.3**
- The same pattern outside designs: the plan named #417’s file half as #516’s first slice before anyone read what it depends on, forcing plan change 1; and #683 was filed with a cause a later read of `store-recover.mjs:62` corrected. **res 2.5, res 3.4**
- **Action:** every design or grooming claim cites the line it read; critic reviews before the person approves, or the block says it’s pre-review. **res 5.1, res 5.2**

### T6. The tester’s runs as a subagent were cheaper but brittle (2 of 5)
- Critic’s subagent was cut off twice by restarts and once finished without reporting; its results were recovered from logs by hand. **crit 1.3, crit 4.2, dev 3.5**
- **Action:** runs write their commands and exit codes to a log as they go, with a time limit, or the tester comes back as an agent. **crit 5.2**

## Where the answers differ

- **Rule 12:** researcher and kiro-ssh-x86 say the quality reworks aren’t rule 12’s measure, since the bar already existed in `AGENTS.md` and review didn’t apply it; claude-ssh would count 5 PRs, treating the bar as a late rule. The table follows the majority and notes the other view.
- **Estimates:** developer and critic say S3a was underpriced because the definition of done omitted the quality bar; claude-ssh says its own items held for the build, and review rounds were what ran long.
- **Validation cost:** kiro-ssh-x86 says duplicate full-suite runs by author and critic added validation cost and machine load, while noting the evidence was strong; no one else weighed that against the gaps critic’s runs found.

## Single-source points worth keeping

- One estimation round (round 5, #516-S1) was voided because a card’s value was posted before the others were written. **res 2.3**
- Grooming should list merged PRs that *mention* an issue: #427, #296 and #564 were left open by PRs that linked none. **res 2.4, res 5.3**
- Check during grooming that a recorded failure still reproduces (#544’s Kiro error no longer does). **dev 2.4, dev 5.3**
- Shared-checkout hazards: a nested worktree, a v1.0.0 checkout 451 commits behind, `node_modules` linked from it (which dropped `@playwright/test`), and `git stash` in a shared worktree. **res 1.1, res 1.2, dev 1.2, dev 1.3, crit 1.1**
- A uniform result is a finding until explained: zsh didn’t split an unquoted array, so a mutation table was all exit 1; `$?` after a chained command printed 0 on a conflict; a missing `node` made a stress run 10 of 10 failed. Rerun each check alone, one per line. **ssh 3.4, crit 3.3**
- A Linux-only test (`/etc/hostname`) passed on the host and failed on the Mac. **ssh 3.3, crit 3.3**
- The UAT runner deletes a host’s whole `~/.postbox-remote`. **dev 4.1**
- Postbox gaps: review blocks need the whole old text for a diff (**res 4.2**); malformed blocks show their plain-text fallback before the error names the field (**res 4.3**); messages cut at 2,000 characters hide hand-offs (**ssh 4.4**); Mermaid “Unsupported markdown: list” (#684, **crit 4.4**); the UAT tester can’t see glossary links (**crit 4.5**); acknowledgment loops (#331, **dev 4.3**).

## The working agreement’s measures against sprint 1

| Rule | Measure | Sprint 1 | Sprint 2 | Source |
|---|---|---|---|---|
| 8 | Longest hand-off wait on a card | 7 h | ≥ 2 h (the 18:52 UTC card); S3b’s missed wake 78 min | T1 |
| 11 | Missing tool or wrong role found after a first branch | 3 | 0 (claude’s critic persona caught before its first item) | `sprint2-second-dev-who` |
| 12 | Branches rewritten for a rule that arrived late | every open branch | 0. The quality reworks (#678, #679, #682, #688, #689) came from review not applying existing rules, counted under T2 and rule 21; claude-ssh would count them here | “Where the answers differ” |
| 13 | Share of sprint PRs with points | 5 of 17 | 8 of 8 (#676–#679, #682, #687–#689); one round voided for anchoring | `estimates-final.json`, res 2.3 |
| 14 | Planned items never started | 4 | 0 unreplanned (#464-b, #670 moved to sprint 3 by your choice) | plan change 1 |
| 15 | Items rebuilt after a decision changed | 1 | 0 | — |
| 16 | Merges of `main` into an open PR to resolve a conflict | about 8 | 0 (`main` merged into #687 and S3a for currency, not a conflict) | PR heads |
| 17 | Median PR open to merge | 6.2 h | 0.99 h over the 6 merged (0.29–1.9 h) | `gh pr view`, exit 0 |
| 19 | Heads handed to review that then failed the gate | 3 | 1: #689, which passed on its Linux host and failed on the reviewer’s Mac, a platform gap (ssh 5.2). #688’s `fe497c03` isn’t counted: it was handed over labeled work in progress, “not yet gated”, as rule 19 allows | T2, crit 3.3 |
| 21 | PRs with blocking integrator points after the room’s approval | 7 | 2 (#682, #688); #678, #679 and #689 were then reworked from critic’s own re-read | T2 |
| 23 | Reviews that crossed a newer push | ≥ 4 | ≥ 4 (#544, #688 twice, #689) | T7 |

**Velocity:** 24 points merged in 3 h 58 m (19:35 to 23:33 UTC), with #688 (8) and #689 (5) still to merge. Sprint 1 merged about 42 points a day.
