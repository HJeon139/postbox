# Retrospective, #508 sprint: gpt

Role this sprint: line-by-line reviewer and peer implementer. I owned #582 part 3 (landed with #616), #617, #625 (the lint-caps ratchet), #608 and then its split (#630, PR 1 of A1), and #708 (the delivery-routes design). I gave peer reads on #609/#632, #366/#633 and the #470 spike (#631).

## 1. Room setup

- **Helped: the confirm with its checks in the script.** Each push confirm checked the full head SHA, a clean tree, the merge base, the remote branch and the hashes of the texts, and stopped on any mismatch. It stopped real mistakes. My own first #630 confirm (`push-630-44e71417`) was answered after its texts had changed, so its hash check would have failed, and nothing ran until the person confirmed `push-630-44e71417-r2`.
- **Helped: rules 19 to 21.** Before rule 19 (hand-back with `#PR @head:`), asks went quiet. Researcher's “out of 8 PRs only one is marked ready” question, and the threads proposal, came from that. Rule 21 (a sign-off states its scope against `main`) came from my spike review, where my sign-off covered only the deltas I'd read.
- **Got in the way: a reader for every head, plus a separate approval for every text.** One #630 round took the code, a critic read, the person's approval of the reply and body (`reply-630-1`), a push confirm, then CI and a label confirm. The person's later choice in `reset-508-1` (approve pushes only, and a rebase with no code change keeps its sign-off) removed one of those steps.
- **Got in the way: one reader as the bottleneck.** Researcher's queue table for critic had five reads waiting at once (#630, #632, #629, #633's design, #637's design), and my #630 push waited behind it.

## 2. Design and planning

- **Worked: rule 13, a half page read before code.** The #633 design read (`design-633-turn-1`) found the case of a turn that doesn't move on, before code. The relaunched fresh-subagent review at `e776d4b0` found the same class again after a restart, and it is still open on #633.
- **Didn't work: a design and dormant code staged ahead of their consumer.** #608 carried 513 lines of reducer, records and producers with no producer on `main`. The integrator rejected it and asked for a split: PR 1, then A1b, then A2. #630 is that PR 1. Its first version still claimed a browser boundary wider than what it enforced, which became the integrator's blocker on #630.
- **Didn't work: a design that lived only in a local branch.** `designs/508/delivery-routes.md` was approved, but it lived only on a clone whose remote wasn't GitHub. The integrator's review of #608 couldn't open it. It reached GitHub only at the close, as #708.
- **I'd change: write the conflicts between PRs into the plan, not only into each PR body.** #630 and #632 both rewrite `shared/state.mjs` and `server/live-streams.mjs`. Both bodies carried a four-item list for whichever landed second. The order belonged in the execution plan, once.

## 3. Execution

- **Why defects reached the integrator: the reads confirmed the design and didn't attack it.** #625 went through rounds of bypasses: a nested `biome.json`, failing open with no base, the net count of ignores, an `info` level, a `./` spelling, a new module with the rule off. Then the integrator found four more, and the check was rewritten to fail closed. On #630, the integrator found a second list of event types beside the table (`keepEvent`), and the backlog's table argument untested. Our mutants had run only against the spec files nearest the change.
- **Why: failing-first came from the owner's log, not a rerun.** Critic adopted the integrator's review guide late in the sprint. It reruns new specs on `main`, deletes a line against the whole suite and runs `git merge-tree` against every open PR. On its first day, it caught #630's conflict with #638 in `app/js/client.mjs` and #639's spec gap on the page path.
- **Flowed: the owner watches their own CI in the background, and the reviewer never polls.** #630 at `44e71417` and #708 at `d18fb15f` both went from push to counts in one background watch.
- **Waited: rebases when `main` moved under a lint rule.** #638's floating-promise rule conflicted with #630 and forced a new read and a new confirm. A no-code rebase keeping its sign-off (`reset-508-1`) fixes the common case.
- **My own slip:** I showed a confirm with a placeholder in its texts block, then edited the body while it was open. The person confirmed revision 1. The hash check saved it, but it cost a second confirm. I should build every file, hash it, and only then show the block.

## 4. Harnesses and quota

- **Commit identity drifted across harnesses.** The seven delivery-routes commits (`0c5999ed` to `b96462e0`) carry the person's name and no co-author trailer, against the room's convention (`user.name=gpt` plus the trailer). They were squashed into one commit with the right identity for #708. `lint-commits` checks the header and nothing about the author or the trailer.
- **Work was stranded by where a harness kept its clone.** The delivery-routes branch and the #582 settle note (`6164f389`) were in local clones only. At the close, one was opened as #708, and the other turned out to be merged already (`ff86959b`). An agent moved to another harness can't see or push what the old harness left on disk unless someone sweeps for it, which researcher's closing plan did.
- **The switch to Claude kept the work going but lost context.** After the switch I resumed from summaries. Exact SHAs and hashes survived because they were written into files and scripts, not only stated in chat. Anything kept only in the conversation had to be re-derived.
- **I'd set up differently:** every agent's branches live in GitHub-backed worktrees from the start, and a commit hook checks the author and the trailer, whatever the harness.

## 5. Postbox itself

- **An answered review block takes no comments.** My peer read on `design-633-turn-1` was refused by `review_block` because the person had already approved it, so the line comments went into a prose message instead.
- **An update can race an answer.** `update_block` on `push-630-44e71417` was refused because the person had answered revision 1 meanwhile, against a script I'd since changed. The refusal was correct, but the block doesn't show that its files changed after it was shown.
- **No agent could open a thread.** Rules 19 and 20 wanted one thread per PR, and no tool did it, which is #637 (`open_topic`, #639). The catch-up also dropped older items (#507), so I re-read the conversation to find asks.
- **Long confirms need their texts in a separate block.** The texts don't fit in a 2,000-character statement, so a confirm and its texts are two blocks that can drift apart.

## 6. For the next sprint, in order

1. **An adversarial fresh-subagent review before any PR reaches the integrator.** It reruns failing-first on `main`, deletes a line against the whole suite, runs `merge-tree` against open PRs, and checks the docs against the code. Critic does this now. Make it the gate for `ready for integrator`.
2. **No local-only work.** A design or branch is pushed to GitHub (as a WIP branch if not ready) in the turn it's approved. A hook checks the commit's author and trailer, whatever the harness. A sweep of local branches against GitHub runs each week, not only at close.
3. **One confirm that carries its texts.** Postbox should let a confirm attach files, show them in full and hash them itself, refusing to run if any changed after it was shown. Until then, owners build and hash every file before showing the confirm, never after.
