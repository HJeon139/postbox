# developer: blind retrospective, #508

Written before reading anyone else's answer. My part was the #601 held reads, #609/#610 (PR #632), #637 and #507 (PR #639), and the `runtime.mjs` split design.

## 1. Room setup

- **Helped:** every outward write went through a block the person approved, with the head re-checked by SHA inside the command. It caught moved heads more than once: `run632.sh` and `run639*.sh` each check the remote branch and the PR's head before pushing.
- **Helped:** rule 19's hand-back format (`#PR @head:`, with done, blocked or not mine, plus CI counts) made it clear who owed the next move. My hand-backs for #639 at `fc8c568e`, `8ed9aa5c`, `334a0800` and `611c243c` each name the head and the counts.
- **Got in the way:** messages crossed. engineer and critic each re-sent findings I had already fixed ("our messages crossed again", engineer at `41cd2e2c`, critic at `fc8c568e`). It cost a turn each time, and twice I re-explained a fix that was already in the room. One thread per PR (rule 20) wasn't usable until #639 shipped `open_topic`, so the crossing went on all sprint.
- **Got in the way:** the rules grew mid-sprint (19 to 21, then the review guide in #659, the UAT rule, then researcher's correction in `it_ClZ9X3aR`). On #639 I ran a mutant sweep and a subagent sweep that the next message withdrew. The work wasn't wasted, since it found two real `open_topic` bugs, but the ask changed while I was doing it.

## 2. Design and planning

- **Worked:** rule 13's design read before code. #637's note went through three revisions before any code: critic's read moved the gate into one module (`closedTo`) and added `store.pending.thread`, and engineer's read found the route and the narrower I6. None of those came back as integrator findings.
- **Worked:** fixing by class. #609's sweep over every `apply` consumer (PR #632's reply table) found the held view's rethrow, and #637's one write gate fixed every host write tool, not just `open_topic`.
- **Would change:** design notes cited code names that later moved. The integrator's blocker 2 on #639 was the note naming `storeClosedTo` and `catch-up.mjs` after the code had moved them. A note's names should be checked against the tree in the same commit that moves them. I added that check to #639's body (53 names grepped), but only after the integrator asked.
- **Would change:** I deferred spec 8 (the UAT trigger) as "A2's work", because `delivery.md` was capped at eight phases. A new scenario (`opentopic.md`) took twenty minutes. The cap was a reason to put it somewhere else, not to skip it.

## 3. Execution

- **Flowed:** failing-first specs, then the fix, in separate commits (#639: `325c97e8` then `37525388`, `c1758927` then `8ed9aa5c`, `c5705b0b` then `bc8e8c5c`). Each review could rerun the red commit.
- **Waited:** each round on #639 waited on two sign-offs, the person's approval of the body, a push confirm, then CI, then a hand-back. Rounds took hours of wall time for changes of 10 to 50 lines.
- **Why defects reached the integrator:** I tested the case I fixed, not its neighbours. #639's lost message (every mention refused) sat beside the spec I had for "one mention refused". My first fix for it (`37525388`) also brought in a double post on Allow, which a sweep caught (`c1758927`), not my specs. critic's fresh subagent then found the summary-turn bypass (#225, `it_9twlQA3v`), a rule enforced in each caller rather than in `agentWake`.
- **Why, second cause:** in-session reviewers shared the author's framing. critic signed `41cd2e2c` past a silent queued call that engineer found, and said its mutants never sent a queued tool through the gate. Once critic's pass moved to a fresh subagent, it found new blockers on #631, #633 and #639 before the integrator did.
- **My own process slips:**
  - **Uncommitted fixes lost:** twice I restored a file with `git checkout` after a mutant and dropped an uncommitted fix (`turns-tools.mjs`, then `side-threads.mjs`).
  - **Lint skipped:** twice I committed after Biome but before `lint:project` (`e0d32773`, `bc8e8c5c`).
  - **A wrong SHA:** I cited `7f6f2b0a` for a commit that is `82aa6d64`.
  - **What fixed them:** each was caught before a push, by the gate or by my own diff.

## 4. Harnesses and quota

- **What I saw:** I ran on Claude Code all sprint, so I can't speak first-hand to Codex or Antigravity failures. What reached me were their PRs: gpt's #630, which my #632 had to rebase onto, and gemini's #631.
- **#631 showed a harness-specific risk:** fixtures recorded from real CLI sessions carried home paths, an installation id and account fields. A temp-folder path then survived the first rewrite, because the privacy test matched only the slash form. Recorded fixtures from any harness need a content check in the gate, not care.
- **Cross-harness seams cost rebases:** #630 and #632 both changed `shared/state.mjs`, and #639 conflicted with `main` after #682 and with #689 in `server/mcp.mjs`. Each needed an explicit seam note in both PR bodies.
- **Would set up differently:** one owner per shared file per sprint (`shared/state.mjs`, `server/mcp.mjs`, `tests/store-held-guard.test.mjs`), or land the table-shaped refactors first. Then parallel agents, on any harness, don't each carry a seam.

## 5. Postbox itself

- **Confirm blocks cap their statement at 2,000 characters,** so a push with its body and reply inside didn't fit. I used review blocks as push confirms (`push-639-r2` to `r4`). That works, but "approve" and "push" are then one click, and the diff from the last approved body is prose I wrote, not a computed diff.
- **A progress block left running at turn end is marked stalled,** but a background job (a gate, a subagent) re-invokes me later. I had to leave steps running or close them early (`progress-639-r2`).
- **Topic threads in the page:** in two of the three `opentopic` UAT runs, the tester couldn't open a topic thread from its message's reply count. I checked the threads in the event log instead.
- **#485 reproduced** in a UAT run: an agent reply posted with no text.
- **Truncated reads:** catch-ups and `read_conversation` cut long findings at 2,000 characters, so I needed a `read_message` for every critic finding.

## 6. For the next sprint, in order

1. **Push the reviewer's adversarial pass earlier, without making authors run it:** critic's fresh subagent reads the design note and the first red commit, not only the "ready" head. Neighbour cases then become specs before the fix, not after the integrator.
2. **Enforce a rule in the function every path calls, and add a guard spec that every caller goes through it.** #225 in `agentWake`, the write gate in `closedTo` and #366's need in `nextNeed` were all bugs from a rule in some callers but not others.
3. **Name an owner and an order for shared files at sprint start** (`shared/state.mjs`, `server/mcp.mjs`, the held-read guard table), and land the table-shaped refactors first. This sprint, three PRs carried seam notes and two needed a merge or rebase to resolve a single line.
