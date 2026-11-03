# Sprint 2 retrospective: aggregate (draft 1, 2 November 2026)

Five blind answers, each checked against the hash its author posted before anyone read the others: researcher `4ff674db`, developer `1641c233`, critic `8e40f31d`, claude-ssh `64394c32`, kiro-ssh-x86 `d074d3a3`. A source like **dev 3.2** means developer’s answer, question 3, bullet 2. Themes are ordered by how many agents raised them.

## Where the answers agree

### T1. Held and missed wakes cost the most waiting (5 of 5)
- A declined “add tester” card kept holding @-mentions from 18:52 UTC for hours: critic’s approvals of #678 and #679 never reached claude-ssh, and gpt’s #489 check never went out. **res 1.5, dev 4.2, crit 1.2, crit 4.1, ssh 1.3, ssh 4.2**
- A hand-off written “claude-ssh, …” without the @ didn’t wake it, and S3b sat on an old head for over an hour. **dev 1.5, ssh 1.3**
- Messages crossed constantly: a head named, and the reply naming the head before it. **dev 4.4, crit 3.4**
- **Action:** file the Postbox defect (a declined add-agent card keeps holding mentions; the sender gets no signal). Rule: every hand-off @-mentions the agent that must act; handles in prose go without the @. **ssh 5.3, crit 5.3**

### T2. The quality bar arrived after approval (4 of 5)
- #682 (nested ternaries, 280-character template lines) and #688 (scans of the whole state per write, an O(n²) `prunable`) both carried critic’s approval and `ready for integrator` before the person found them; #678 and #679 were then re-read the same way. **crit 3.1, dev 3.2, ssh 3.2, kiro 3.5**
- Biome doesn’t check for either: `noNestedTernary` reports 290 hits on `main` (#685), and cognitive complexity isn’t on. **dev 3.2, dev 5.1**
- Estimates didn’t price it: S3a was carded 8 (one card 13) and took three more review rounds. **dev 2.3, crit 2.4**
- **Action:** a quality and complexity pass before any approval or label; #685 into the gate; “time complexity per write” in the definition of done. **crit 5.1, dev 5.1, ssh 5.2**

### T3. Remote hosts make every hand-off a paste (4 of 5)
- Agents on a host can’t read the laptop’s files, designs or attachments (#417, #671-b), so every hand-off restated diffs and exit codes, and designs were read from review blocks. **ssh 1.2, ssh 4.1, kiro 4.1, res 4.5, crit 4.3**
- `node` wasn’t on the agent shell’s PATH (#672). **ssh 1.1, kiro 1.3**
- **Action:** #516’s remaining slices (S2, S4, S5) and #671-b first in sprint 3. **kiro 5.1**

### T4. Mutations and red runs caught real gaps every time (4 of 5)
- #564-rest’s `seen` guard, #544’s M11, #671-a’s M8, #673’s (g), S3a’s five survivors: each became a test before its PR opened. **crit 3.2, ssh 3.1, kiro 3.3, dev 3.1**
- **Action:** each hand-off lists its new guards and the mutation that fails for each. **kiro 5.3**

### T5. Machine load and the locks (4 of 5)
- Load reached 200–415; gates failed on timing tests that pass alone; browser runs started in parallel once. **dev 1.4, crit 3.5, kiro 1.4, kiro 3.5**
- **Action:** the shared lock becomes the only supported way to run gates and browser suites, with exit-code capture in the same command. **kiro 5.2**

### T6. The tester’s runs as a subagent were cheaper but brittle (3 of 5)
- Critic’s subagent was cut off twice by restarts and once finished without reporting; its results were recovered from logs by hand. **crit 1.3, crit 4.2, dev 3.5**
- **Action:** runs write their commands and exit codes to a log as they go, with a time limit, or the tester comes back as an agent. **crit 5.2**

### T7. Stacked PRs churned (3 of 5)
- #688 moved six times after first approval; each move cost S3b a rebase and critic a re-read. **dev 3.4, ssh 2.2, crit 3.4**
- **Action:** batch fixes to a head under review into one push; for stacked work, A names an interface commit B builds on. **dev 5.2, ssh 5.1**

### T8. Designs: reviewed before code paid off; approved before review didn’t (3 of 5)
- S1’s two P1s and S3’s delete-by-absence were fixed in the design, before any branch. **crit 2.2, ssh 2.1, res 3.1**
- Two designs were approved before critic’s review, so its findings needed another revision; S3 needed four revisions, each an unread claim. **res 3.2, res 3.3, crit 2.3**
- **Action:** every design claim cites the line it read; critic reviews before the person approves, or the block says it’s pre-review. **res 5.1, res 5.2**

## Where the answers differ

- **The tester as a subagent:** critic and developer saw it fail; nobody else commented. Critic offers both fixes (logs, or the agent back).
- **Estimates:** developer and critic say S3a was underpriced; claude-ssh says its own items held, and building wasn’t what ran long.
- **Validation cost:** kiro-ssh-x86 says author and critic both running full suites doubled the load; no one else weighed that against the gaps critic’s runs found.

## Single-source points worth keeping

- Grooming should list merged PRs that *mention* an issue: #427, #296 and #564 were left open by PRs that linked none. **res 2.4, res 5.3**
- Check during grooming that a recorded failure still reproduces (#544’s Kiro error no longer does). **dev 2.4, dev 5.3**
- Shared-checkout hazards: a nested worktree, a v1.0.0 checkout 451 commits behind, `node_modules` symlinks, and `git stash` in a shared worktree. **res 1.1, res 1.2, dev 1.2, dev 1.3, crit 1.1**
- `$?` after a long chained command reported 0 on a conflict. **ssh 3.4, crit 3.3**
- A Linux-only test (`/etc/hostname`) passed on the host and failed on the Mac. **ssh 3.3, crit 3.3**
- The UAT runner deletes a host’s whole `~/.postbox-remote`. **dev 4.1**
- Postbox gaps: review blocks need the whole old text for a diff (**res 4.2**); messages cut at 2,000 characters hide hand-offs (**ssh 4.4**); Mermaid “Unsupported markdown: list” (#684, **crit 4.4**); the UAT tester can’t see glossary links (**crit 4.5**); acknowledgment loops (#331, **dev 4.3**).

## The working agreement’s measures against sprint 1

| Rule | Measure | Sprint 1 | Sprint 2 | Source |
|---|---|---|---|---|
| 8 | Longest hand-off wait on a card | 7 h | ≥ 2 h (the 18:52 UTC card; S3b’s missed wake over 1 h) | T1 |
| 11 | Missing tool or wrong role found after a first branch | 3 | 0 (claude’s critic persona caught before its first item) | `sprint2-second-dev-who` |
| 12 | Branches rewritten for a rule that arrived late | every open branch | 4 PRs reworked for the quality bar after approval (#678, #679, #682, #688) | T2 |
| 13 | Share of sprint PRs with points | 5 of 17 | 8 of 8 (#676–#679, #682, #687–#689) | `estimates-final.json` |
| 14 | Planned items never started | 4 | 0 unreplanned (#464-b, #670 moved to sprint 3 by your choice) | plan change 1 |
| 15 | Items rebuilt after a decision changed | 1 | 0 | — |
| 16 | Merges of `main` into an open PR to resolve a conflict | about 8 | 0 (`main` merged into #687 and S3a for currency, not a conflict) | PR heads |
| 17 | Median PR open to merge | 6.2 h | 0.99 h over the 6 merged (0.29–1.9 h) | `gh pr view`, exit 0 |
| 19 | Heads handed to review that then failed the gate | 3 | 1 (#689 on macOS) | T2, crit 3.3 |
| 21 | PRs with blocking integrator points after the room’s approval | 7 | 2 (#682, #688) | T2 |
| 23 | Reviews that crossed a newer push | ≥ 4 | ≥ 4 (#544, #688 twice, #689) | T7 |

**Velocity:** 24 points merged in 3 h 58 m (19:35 to 23:33 UTC), with #688 (8) and #689 (5) still to merge. Sprint 1 merged about 42 points a day.
