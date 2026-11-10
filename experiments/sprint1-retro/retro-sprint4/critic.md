# Blind retrospective, sprint 4

## 1. Room setup

- The close plan assigned one independent PR check and one blind retrospective to critic, with no GitHub writes; room message `it_Y7uKHKt3` records that contract and the requested evidence fields.
- The room’s review labels were useful as a queue signal, but they did not stand in for current CI or mergeability: PRs #1181 and #1177 were labeled `integrator approved` while their current states were respectively failing CI and conflicting.
- The evidence boundary helped the review: PR #1203’s existing `ready for integrator` label was checked against its current head and current checks rather than accepted from the room’s state table.

## 2. Backlog grooming, estimation and planning

- The plan separated independent verification from the state-at-close draft; PR #1203 shows why this matters, because a documented readiness label still needs a fresh head, CI result and mergeability check.
- The review queue was visible enough to identify work waiting on the person: PRs #1200, #1199, #1195, #1181 and #1177 all had integrator-facing labels or approval history, while their gates differed.
- Planning should make gate ownership explicit: PR #1198 had a clean mergeable head but `gh pr checks` returned exit 1 with no checks reported, so “ready” cannot mean only “mergeable.”

## 3. Execution

- The strongest flow came when a change carried its own validation: PR #1194’s review history records a differential replay and repeated tests, while its current check set still contains a cancelled browser job that needs interpretation.
- CI was not a single green/red fact: PR #1185 had a failed “New and changed specs, ten times” check; PR #1181 had three failed checks; and PR #1175 had two failed browser checks, all on their current heads.
- Integration waits were concrete rather than abstract: PR #1177 was `CONFLICTING/DIRTY` despite green checks and approval, while PRs #1188, #1184 and #1165 still had in-progress checks.

## 4. Postbox itself

- Queue failure handling slowed multi-agent work: PR #1169 records that one held recipient blocked healthy recipients on the same entry, with a fixture reproduction and a design change requested.
- Long prompts crossed backend boundaries in ways that needed explicit product behavior: PR #1190 records an uncaught stdin `EPIPE` risk and a platform-specific argument-limit regression.
- Review rendering needed browser-specific validation: PR #1159 records that detached highlight ranges did not paint in Firefox and that a size-only assertion missed the defect.
- State durability remained a room-level risk: PR #1194 records that U+2028/U+2029 could break line-format snapshot reads and that truncation could load a smaller state without error before its fixes.

## 5. For the next sprint

- First, make readiness a verified state rather than a label: require current-head CI, mergeability and review state together, motivated by PRs #1181, #1177 and #1198.
- Second, expand browser and stream coverage for timing-sensitive UI behavior: PR #1159’s Firefox paint regression and PR #1194’s cancelled browser check show why one passing path is insufficient.
- Third, keep failure isolation and recovery as explicit queue invariants: PR #1169’s multi-recipient hold reproduction should become a permanent regression case before adding more orchestration.
