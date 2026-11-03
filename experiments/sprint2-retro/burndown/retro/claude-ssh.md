# Sprint 2 retrospective: claude-ssh

## 1. Room setup

- **The start-of-room check (rule 11) earned its keep.** It found that `node` wasn't on the PATH of my shell on the remote host (exit 127) before any branch existed, which became #672. Every report after that named the Node it used.
- **Working on a remote host meant every bit of evidence had to be pasted.** No one could read my worktrees or `.scratch/` (#417), so each hand-off restated diffs, exit codes and measurements in the room. The design files lived on the laptop's `.scratch/`, and I read the S1 and S3 designs from their review blocks (`it_j8nFcp0`, `it_qzBQR8S`) rather than from the files.
- **Missed wakes cost the most time.** One review approval sat behind a stuck “add tester” card for a whole round, and a rebase request went out without an @, so nothing woke me (scrum-master's note at 15:33, “claude-ssh was never asked to rebase”). Both were invisible from my side until someone relayed them.
- **The working agreement kept heads honest.** Naming the head, pushing on its own commit after review, and checking `git ls-remote` (rules 19 and 23) meant every reviewer read the commit I meant, across about eight rebases of S3b.

## 2. Grooming, estimation and planning

- **Designs shown as review blocks before building worked.** S1 and S3 were built from approved text (revision 2 for S1, revisions 3 to 4 for S3), and when I found a gap, `TOOL_ROUTES` needing the six tools, it went into revision 3 as a row instead of a surprise in review.
- **The S3a/S3b split was right, but stacking added work.** S3b sat on a moving S3a: 18e244e2, 494ea2e0, 77c75da4, 72841cae, dbad81c8, e33002ca, ab5e5da5, 228b0a4a, bcf9c45b, cd3f3dac. Each move meant a rebase, a gate and a new head for critic. The tools couldn't merge before the store anyway, but a frozen API point would have saved most of these.
- **Decisions put to the person as choice blocks stuck.** Keeping the tool names, at the cost of a round trip each (`claude-ssh-s3b-names`), was settled in one click and recorded in the test that enforces it.
- **The estimates held for my items.** #564-rest (3), S1 (5) and S3b (5) each landed inside their round's marks for the build. What ran long was review rounds, not building.

## 3. Execution

- **Red runs and mutations caught real gaps every time.** For example: m2 and m4–m6 on #678's sweep, the `from` clamp and footer on #679, M7, M15 and M22–M24 on S3b. Each became a test before the head was handed over.
- **Review found what my gate didn't: legibility and complexity.** Nested ternaries and a rule decided twice on #679 (`partOf` came out of that), `onMsg`'s four concerns on #678, and the scans of every room on S3b's `list_assets` (35 ms with 100,000 assets elsewhere, 180 µs after). I should run `noNestedTernary` and a complexity read on my own files before handing off.
- **Platform assumptions slipped through.** `/etc/hostname` passed on this Linux host and failed on the reviewer's Mac (#689, `2e033d30`), and the test runs leaked file handles and 5,566 temp folders until review asked.
- **My own tooling misled me twice, and I caught it only by distrusting uniform results.** zsh didn't split an unquoted array, so a mutation table was all exit 1. `$?` in long chained commands printed 0 for a `git merge-tree` that conflicted, and `node` was missing from one shell's PATH, so a stress run showed 10 of 10 failed. I reran each check one per line and said so in the room.
- **Agentic UAT on the stacked head was the decisive evidence for #688 and #689.** It showed sharing across machines, and on the second try it reached the stale-write refusal on purpose.

## 4. Postbox itself

- **#417 and #516's file half:** agents on a host can't read the laptop's files or attachments. That's the root of the paste-everything workflow above.
- **A held card blocks every later @-mention silently** (rule 8's measure). From the waiting agent's side there's no signal at all.
- **#672:** an agent's shell on a host doesn't get the person's login PATH.
- **The review-block and message size cuts (2,000 characters) hide parts of hand-offs.** I often read `read_message` to see the rest of a reviewer's point.

## 5. The three changes I'd make first

1. **A frozen interface point for stacked work.** When B builds on A, A names the API commit, and later commits to A that don't touch it don't move B. Or B waits to rebase until A's final head, as happened at the end.
2. **Run the reviewer's quality checks before handing off:** `noNestedTernary` (#685), a complexity and data-structure read, and a test on a second platform, or at least no reads of host files in tests.
3. **Make a missed wake visible.** An @ that woke no one, or a mention held behind a card, should tell its sender at once, and hand-offs should always @ the agent that must act.
