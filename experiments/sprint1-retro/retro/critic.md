# Critic’s retrospective, sprint 1

## 1. Room setup

- **Helped:** a separate reviewer and a separate tester for every head. Tester’s red runs and my reading kept catching different things. On #511, tester’s probe and my P1 found the same `'system'` masking from different sides (#511 at `b8c010e`). On #485, tester’s mutation found the untested lost-link guard that I had called acceptable (it_GeK1Xh; `2acecf0..451cb63`).
- **Helped:** rule 13’s pre-approved test budget, and read-only access to the repo and `gh`. I could run red runs, `git merge-tree` checks and timing probes without asking (#495’s scanner timings at `3396647` and `593c330`).
- **Got in the way:** wake cards held my hand-offs several times with no sign on my side, until a “[Postbox] Your mention of @x woke no one” note arrived a turn later. Two of my approvals had to be resent (#483 and #485 in the 18:2x UTC check-in round). That’s #439’s class of problem, seen from the sender.
- **Got in the way:** gpt’s Kiro session had no Postbox tools at all (#489; it_MM9VLGV5, it_R4npxS4). My reviews of gpt’s work reached it only through its catch-up, and its PR bodies had to be relayed.
- **Got in the way:** roles that didn’t match the work. Both Kiro agents ran with reviewer or researcher instructions while working as developers (#504’s comment, and the `kiro-x86-persona` block). That meant the “show the test failing first” rule wasn’t in their prompts.

## 2. Grooming, estimation and planning

- **Worked:** blind estimates against a fixed scale with reference items, written to separate files (`.scratch/grooming/poker-round2.md`, the estimates JSON files). The spread showed where scope was unclear, and the re-vote split three items.
- **Didn’t work, my part:** my first urgency picks counted #150’s bypass (already fixed by PR #449) and #400 (disclosed in the UI) as trust-boundary defects. I hadn’t checked `main` first. Both were corrected and recorded in the retrospective.
- **Change:** a P0 should name its trigger and the test that shows it. #326’s broad title (“wake dropped”) was disproved by the 26 October reproduction, and #439 named the real trigger. Writing that down at grooming would have saved a round.
- **Change:** estimate hotfixes too. #504, #492, #503 and #510 took a large part of the sprint’s review time and are absent from the burndown, because none had points.

## 3. Execution

- **Flowed:** a small loop of push, critic’s review, tester’s red and stress runs, then the PR. On a good day a fix went through it within an hour, for example #496’s purge fix (`11d7084..f4e7e67`) and #510’s handler (`152c50d..111a168`).
- **Waited:** on stale reviews. Several times an author pushed a new head while my review of the old one was in flight, and the next round was spent on “that crossed with my push” (#492 at `9d60fb9` against `7c41687`, #495 at `c343e3b` against `3cfdb20`, and #451 more than once).
- **Waited:** on merges of `main` into open PRs. Shared files, `designs/intent.md` row 129 and `claude-stream.mjs` most of all, conflicted repeatedly (#511 `d11c762`, #512 `2dbbf56`, #513 `7234d68`, #536 `dfee586` and `5145312`). Each needed a new check that the resolution kept both sides.
- **My misses, found later by the integrator:**
  - #513: I didn’t diff the moved `clip` against the old one (`cd13330`).
  - #536: the `/compact` empty reply, and the Retry double wake, which I had thought of and let go.
  - #509: CJK text and long tokens.
  - #511: slash and reattach turns.
  - #495: queued lock requests, and duplicate reports.

  The common cause: I checked the change’s intended path and not the neighbouring inputs.
- **My wrong finding:** a P2 on #497 and #498 about kept read replies. Developer showed that those calls never reach `onTool`, because they’re answered on the host (`broker-tools.mjs`). I had assumed the route without reading `TOOL_ROUTES`.

## 4. Postbox itself

- **The wake card held unrelated hand-offs** (#439, #492). One card waiting on the person blocked review requests across the room for hours (researcher’s 08:33–15:48 UTC check-ins).
- **A mention inside quoted text wakes the agent.** My own example, “@gpt: open the PR”, woke gpt for nothing (it_DCDW6ixC).
- **The catch-up cut long messages at 2,000 characters for an agent with no `read_message`** (#489 with #499 and #502). It didn’t bite here, but it could.
- **Duplicate announcements from `wake_agent` beside the reply:** one report could appear up to six times (#481’s comment; it_HKypLD, it_pedTLlz, it_JfqL0RYN).
- **A turn in a topic thread put the room’s catch-up first** (#504, fixed by #511).

## 5. For the next sprint, in order

1. **Review every input class, not only the path the change is about.** Before approving, I’ll list the neighbouring inputs: other backends, slash and attach turns, retries, non-ASCII text, and the branch merged with today’s `main`. Then I’ll test or read each. That would have caught most of the integrator’s re-review findings in §3.
2. **One owner per shared hot file per round** (`designs/intent.md`, `claude-stream.mjs`, `runtime.mjs`), or rebase-ready slices. That would cut the merge rounds in §3 roughly in half.
3. **Fresh sessions with matching roles at the start,** checked with a one-line test (show a choice block, name your role) before any work. That would have surfaced #489 and the role mismatch on day 1.
