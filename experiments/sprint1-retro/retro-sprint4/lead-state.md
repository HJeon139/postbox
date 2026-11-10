# Blind retrospective, sprint 4: lead-state (state, queue, threads, write judge, Antigravity adapter)

Written before reading any other retrospective. Each bullet names its evidence.

## 1. Room setup: what helped, and what got in the way

- **The shared gate lock and load bar kept gates honest, but they also starved them.** It took the lock first, then read the load.
  - #1194’s full gate was queued at 10:35 UTC.
  - It reached the lock and backed off three times, at loads of 23 to 44.
  - It didn’t get its first run until 11:05.
  - That cost was worth paying: every head I pushed had a full gate on it. But on a busy afternoon, a gate took 20–40 minutes to start. (#1194’s gate rows; the 10:35–11:05 lock lines quoted in my reply that turn.)
- **The rule that agents never touch the person’s data folder held, though not because of me.** I asked researcher to run my read-only log check on `~/.postbox` without naming that rule. researcher stopped and asked the person first (the confirm “Read your ~/.postbox once, read-only, for #1210”). The rule worked, and my request should have cited it.
- **One shared GitHub account and git identity made other people’s pushes to my branches invisible.**
  - After the pause, two commits each landed on #1182 (`9015a701`, `d2d7a8ac`) and #1165 (`1c759a9d`, `304d4931`), under the same name as mine.
  - They fixed the same review points that my local, gated commits fixed (#1182’s `7623a257`, gated at 17:22 UTC).
  - Nothing in the room said they were coming. Only a `git fetch` before pushing kept me from pushing over them.
- **Turn limits shaped how I worked.** A turn with no output for 15 minutes is killed, and background subagents die when the turn ends. So I ran short turns, kept gates going with `nohup`, and scheduled wakes, and I saved both rules as memories. It worked, but it turned one job into 20 or more wake-and-check turns (#1194, 10:35–17:00 UTC).

## 2. Grooming, estimation and planning

- **#1180 went from reproduction to an approved plan in about an hour.**
  - I reproduced it on purpose: the snapshot failed past about 68,000 items, and at 70,000 a restart failed with “Invalid string length”.
  - scrum-master approved the plan the same morning (“go ahead with #1180 as revised”).
  - A failure seeded on purpose made the P1 easy to grade.
- **I built a format choice before the person had made it, and it cost two rounds and a history rebuild.**
  - #1194 started as “lines always”. It then became “one value while it fits”, after critic’s C5 option (`96cf6cbf`, `2ce2ed61`), and gained a round on top.
  - The person then chose, and confirmed, “always lines”.
  - The series had to be rebuilt from `fe07c0c1`, with those two commits dropped.
  - A compatibility choice the person owns should be asked, and answered, before the code is shaped around one answer.
- **The trade-off that decided C5 was measured after the recommendation, not before.**
  - My snapshot probe found that a one-value snapshot blocks the server for 0.6–1.4 s on the build host, against 8 ms for lines (#1155, issuecomment-6771224530).
  - On the reference Mac, it was 0.26 s at the person’s size (tester’s run, issuecomment-6772293340).
  - The form’s cost line changed twice after the person could already see it.
  - Measure first, on the reference machine, then recommend.
- **Two items stayed blocked behind merges for the whole sprint.**
  - #987’s fix waited on #1075, and tester’s draft #1147 (`b31e4326`) fails as designed until that fix lands.
  - #1136 waited on #1169.
  - Neither started, because the merges they needed came late or never (#1075 merged near the end; #1169 still has changes requested, per pr-check.json).

## 3. Execution: where work flowed, and where it waited

- **Each layer of review found a class of defect the layer before it missed.**
  - **On #1194, critic’s independent pass found a P1 and a P2 that my tests and seven mutants hadn’t:**
    - `readLines()` also ends a line at U+2028 and U+2029, so a value holding either broke the reload;
    - a line file cut at a line boundary loaded as a smaller state.

    Both are now cases in `tests/store-string-limit.test.mjs`.
  - **The integrator then found defects that critic’s read passed:**
    - two in #1182: a `readlink` target with a leading space was trimmed into another path, and the link walk was exponential, 9.2 s at depth 14;
    - one in #1165: a message for an agent moved off a silent host waited for that host.

    These were hostile filesystem inputs, a cost under an adversarial input, and a state change during the window. None of them was in my failure tables.
- **I lost two full gates to checks that take seconds.**
  - #1194’s gate failed at lint on `72241718` (an unused variable), and at typecheck on `a62b0a08` (`text` possibly `null`). Each failure came after 20–30 minutes of waiting for the lock.
  - Since then, I run `npm run check` before I queue a gate.
  - Another time, I queued a gate right after a commit that the commit-message hook had refused, so it would have gated the wrong head. I stopped it before it started.
- **CI didn’t start on #1194 after a force-push, or after a second push of the same tree.** Closing and reopening the PR started it (#1194, 16:50–16:56 UTC). pr-check.json still shows that run as “CANCELLED”, because the reopen replaced it.
- **The merge queue, not building, was the bottleneck.**
  - #1133 was labeled from about 06:10 UTC and merged at 16:58.
  - At the close, 16–19 PRs were labeled and waiting (state-at-close.md, against rule 17’s 4).
  - #1182 and #1165 went back to “changes requested” after hours in that queue.

## 4. Postbox itself

- **Postbox ran out of memory after 11 hours, at 4 GB (#1210), and again later in the day.** The restart dropped one half-written event: the person saw “Dropped an incomplete event” (block q-1210-dropped). My read-only check found the folder sound, but the restart’s snapshot had already pruned the log from before the crash (issuecomment-6773518983, -6773992194). So the crash window can no longer be inspected.
- **A one-value snapshot blocks the server for its whole `JSON.stringify`:** 0.26 s at the person’s size on their Mac, rising as the room grows (#1155). #1194 removes it, but it isn’t merged.
- **The room couldn’t take the crash log as an attachment:** “Your host can’t open attachments from earlier messages”. So the evidence reached the issue only through scrum-master’s summary.
- **Failed agent turns posted the full 403 text as room messages.** About ten agents did, from about 17:00 UTC. They buried the messages that mattered, and each one may have woken others.

## 5. For the next sprint, in order

1. **Make hostile inputs and state changes part of every failure table, run with a time bound,** before critic reads the PR. That means every reader at a format boundary, text the kernel returns (`readlink`), fan-out and loop structures, and an agent that moves while it waits. Evidence: #1182’s two defects, #1165’s, and #1194’s two from critic.
2. **Ask a compatibility or format choice before building, with costs measured on the reference Mac.** Evidence: C5’s two rewrites, and #1194’s rebuilt history.
3. **Fetch, and compare with the remote, before every push, and say in the room when you push to someone else’s branch.**
   - Evidence: the post-pause commits on #1182 and #1165 under the shared identity.
   - Alongside it, keep running `npm run check` before queueing a gate, and queue only once the commit has landed. Evidence: #1194’s two lost gates, and the refused commit.
