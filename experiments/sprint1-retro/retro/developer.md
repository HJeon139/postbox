# Developer’s answer, sprint 1

Written from my own turns, before reading anyone else’s answer.

## 1. Room setup

- **Separate reviewer and tester helped most.** Critic and tester found real defects in my work that my own gate missed: the `skip` count in #500 that counted system lines `read_conversation` drops (PR #500, `75b2a87`), and the tool recorder that broke `show_app` through `this` on #522 (caught by my own gate only after I added it, `0271da5`). The red run against the code before each fix was the check that kept both honest.
- **The room locks (`.scratch/grooming/with-lock.sh`) helped**, once I used them every time. Before that I removed another agent’s browser lock by mistake (recorded in my turn after #451’s revisions).
- **Shared worktrees and a shared git store got in the way.** A `git stash` with nothing to stash, then a pop, popped another session’s old stash in the #458 worktree, and git’s shared conflict cache later replayed a stale resolution into #498’s merge (`3a2035e`, `shim-harness.mjs`). I stopped using stash for red runs.
- **Load got in the way of evidence.** Gates and browser runs failed under load averages of 70 to 155 and passed on rerun (#493; #492’s lagged run, 17 failures at load 155, then 88 of 88). Each such result needed a rerun and a caveat.
- **The working agreement’s “drafts before outside writes” rule worked**, but it cost a review round for every PR body, claim comment and reply. Where a draft’s head moved after approval (claim on #510, `152c50d` vs `111a168`), I posted as approved and said so.

## 2. Grooming, estimation and planning

- **Estimating #208 as a split** (`.scratch/grooming/estimate208-developer.json`) matched what happened: its pieces shipped separately across PRs.
- **The plan’s merge order (#439 first, rule 12) was right but fragile.** #497 and #498 both moved `TOOL_ROUTES` and `remote-broker.test.mjs`, and every later merge of `main` into #498 needed a hand resolution (`dd0d681`, `3a2035e`).
- **What I’d change: plan around shared files.** #504’s branch, #500’s move of `catchUp` and #492’s rewrite of the intent row all touched the same lines (`d11c762` resolution on #511; the `intent.md` row #536 and #492 both edit). A note in the plan of which files several items change would have ordered or batched them.
- **P0s arrived mid-sprint as hotfixes** (#504, #510, #492) and were handled well, but #492’s decision changed three times as it was built (no pair limit, no limits, then a backstop of 50 that resets; `9d60fb9`, `7c41687`, `6d9e012`). Settling the whole decision before building would have saved two rounds.

## 3. Execution

- **Flowed:** test first, red run, gate, push, review, red and stress run by tester. Every fix in #497, #498, #500, #502, #510 and #522 had a test that failed first, and tester re-ran each red independently (e.g. #522’s table at `3a03ff3`).
- **Waited: on wake cards.** My requests to critic and tester were held by cards several times (“woke no one” notices after #451’s report and #510), and I had to resend with `wake_agent`.
- **Waited: on CI and human review.** I held turns open polling CI early on, which led to the empty post in #485’s incident (`it_UcVzTJKe`); after that I set wakes instead.
- **Waited: on work I picked up from another agent.** #522’s head from gpt failed `npm run check` (a type error and two tests, `bb16133`, `3a03ff3`), since its full gate hadn’t run. The integrator’s second review (17:45) then found three more blocking defects in the lifecycle.
- **My mistakes cost rounds:** I pushed commits that failed the gate (`4abd1d9`, `379d775`) before running it in full, and I first pushed #492 with a breaking-change marker the person hadn’t asked for (`644552f`, replaced within a minute).

## 4. Postbox itself

- **Wake cards held unrelated hand-offs** while the person was away (#439, fixed in #497). Later the pair limit stopped ordinary hand-offs (#492), and its card blocked the room’s requests for hours.
- **The turn summary dropped mentions under its caps** (#484, E4: 3.9% of this room’s summaries left out a mention the agent never got another way), and a message mentioning an agent reached it cut at 2,000 characters (#499).
- **Remote hosts:** a host call Postbox waits on could be applied twice after a reconnect (fixed in #497, `cde2543`), and the hostwakes UAT’s checks misread held wakes until they were rebuilt on #497’s behavior (#451).
- **A rejection nothing handled stopped the whole server**, and a host’s daemon too (#510, PR #514).
- **Polite @-mention loops** (“thanks @a / noted @b”) have nothing to stop them but the chain limit; the mock agents ran forever in a browser test once the pair limit went (#492, `7c41687`).

## 5. For the next sprint

1. **Settle each decision before building it,** as a choice block with the alternatives and their costs, and build only after the answer (#492’s three versions).
2. **Plan the order of items that touch the same files,** and merge `main` into open PRs as soon as a neighbor merges, rather than at review time (#498, #511, #536).
3. **Run the full gate before pushing, every time, under the locks, and give tester the head only after it passes** (`4abd1d9`, `379d775`, gpt’s `d1811486`).
