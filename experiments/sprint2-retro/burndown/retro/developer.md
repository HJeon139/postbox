# Sprint 2 retrospective: developer

## 1. Room setup

- **Helped:** the start-of-room check caught a broken environment before any branch existed. My gate in the shared checkout exited 1 on a nested `tester-522/` worktree and a v1.0.0 checkout. Running it in a fresh worktree from `main`, with its own `npm ci`, gave exit 0 at `46116a91`.
- **Got in the way, my own error:** I made a worktree inside the shared checkout with `git -C`, the same nesting that broke the gate, and had to move it out (#544’s first turn). I also ran `git stash` in a worktree with nothing to save, which applied and dropped an older stash from the repo’s shared stash list. Nothing was lost, but since then I use temporary commits, never the stash, in shared worktrees.
- **Got in the way:** a `node_modules` symlink to another worktree failed two `test:process` lint tests that look for Biome’s binary through it. A real `npm ci --ignore-scripts` per worktree fixed that.
- **Helped:** the working agreement’s locks (`with-lock.sh check`) kept the gates from colliding. But with a load average of 200 to 415 late in the day, two of my gates on #688 failed on timing tests, `telemetry-step-growth` and `remote-daemon.test.mjs:227`. The second also failed on `main`’s code at the same load. The locks cover our checks, not everything else running on the machine.
- **Got in the way:** a mention without the @ didn’t wake claude-ssh (scrum-master, on S3b’s rebase), so S3b sat on an old head for over an hour.

## 2. Grooming, estimation and planning

- **Worked:** blind cards with hashes. My cards agreed with the others’ on most items: #544 5, #564-rest 3, S1 5, #673 5. The one split, #464 at 13, was cut into #464-a and #464-b before anyone built it.
- **Worked:** settling decisions as choice blocks before building (rule 15). #544’s recovery path and #671’s split were each decided in one answer, and neither item was rebuilt.
- **Would change:** S3a was estimated at 8 against my 13, and it took the longest of anything I built. The estimate had no line for the code-quality and complexity bar the person later held it to (#688’s review). Next time, say “time and cognitive complexity per function” in the definition of done, so the cards price it in.
- **Would change:** #544 was planned on a real Kiro error that kiro-cli 2.37.1 no longer produces (four real turns, block `d544-repro`). Checking that a recorded failure still reproduces during grooming, not after the branch exists, would have saved a round.

## 3. Execution

- **Flowed:** small PRs with a move commit first, then the fix, then tests. #544 (#677), #671-a (#682) and #464-a went from claim to approved in one afternoon. Each had a red run on its parent and mutations of every guard.
- **Waited:** on the code-quality bar, set after approval. #682 came back for nested ternaries and 280-character template lines, and #688 for complexity: every write scanned the whole store. Both passed the gate and critic’s first review. Biome’s `noNestedTernary` (290 hits on `main`, #685) and its cognitive-complexity rule (`sweepAssets` was 22) would have caught both before review.
- **Flowed after the fix:** #688’s per-room index took one write from 5.65 ms to 0.7 µs with 10,000 assets elsewhere, and a 400-step consistency test pins it against a recount. Measuring before and after turned “performance hygiene” into a number.
- **Waited:** head churn on stacked PRs. #688 moved six times after it was first approved (`dbad81c8` to `cd3f3dac`), and each move cost S3b a rebase and critic a re-read. Most moves were P3s I could have batched into one push.
- **Waited:** critic’s tester subagent stalled three times without reporting. Critic recovered its results from the logs, but the runs it skipped had to be named each time.

## 4. Postbox itself

- **The UAT runner deletes the host’s whole `~/.postbox-remote` on cleanup.** The remote asset UAT had to use a host no other agent was on, and the person had to allow the deletion.
- **A card that stays open holds every @-mention behind it.** The 18:52 UTC “add tester” card held critic’s and scrum-master’s messages, and gpt’s #489 check, for hours.
- **Agents ack each other in loops (#331).** Both UAT runs logged it again.
- **Messages that cross:** I named a head, and the reply named the head before it, many times (`228b0a4a` and `ab5e5da5`, `cd7e54e3` and `7a9653cb`). Postbox doesn’t show that a newer message from the same agent is already waiting.

## 5. Next sprint, in order

1. **Put the code-quality bar in the gate before building:** `noNestedTernary` and a cognitive-complexity limit in Biome (#685), and “time complexity per write” in the definition of done.
2. **Batch fixes to a head under review into one push,** so a stacked PR rebases once per review round, not once per P3.
3. **Check during grooming that a recorded failure still reproduces,** and record what today’s backend does, before the branch exists.
