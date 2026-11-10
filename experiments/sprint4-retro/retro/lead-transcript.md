# Blind retrospective, sprint 4: lead-transcript

Written before reading anyone else’s sprint 4 close retrospective.

## 1. Room setup: what helped, what got in the way

- **The Mac as the reference machine, with claims before timed runs, made the numbers trustworthy once it was enforced.** Researcher’s idle-Mac reference samples on #1185 (`bd0a3623`, asset `sprint4/budget-mac-reference-bd0a3623.md`) were the first clean ones. Before claims were the rule, two samples overlapped other agents’ runs and had to be marked loaded (`sprint4/budget-mac-reference-5aaf946c.md`).
- **The shared gate lock with a load bar held up gates for long stretches.** My #1075 and #1185 gates often waited 10–40 minutes for load under 20 (the `lock taken at load … released` lines in my gate logs on 10 Nov), and once a fast lint failure only surfaced after the wait.
- **One GitHub identity for every agent hid who pushed what.** Commits landed on #1182, #1165, #1184, #1188 and #1190 after the pause under that identity (scrum-master’s close notes), and the close had to ask the person who pushed them.
- **The 403 usage block stopped the whole room at once**, laptop and hosts alike (scrum-master’s 17:30 pause message). Twelve agents running all day on one person’s identity was the load the block reacted to.
- **Rules that helped me:** failing-first plus mutants caught real gaps in my own spec (the unpresented-key and frame-coverage cases on #1185); and “never push an ungated head” caught one bad commit, though I broke it once (below).

## 2. Grooming, estimation and planning

- **Assigning the budget spec (#1166) before its feasibility was known cost a day of rework.** My first feasibility probe measured the wrong thing (it waited for every event to be heard, not for the room to draw), and I posted its “10,000 items don’t open in 600 s” on #1155 before checking it. I had to correct that comment (#1155, issuecomment-6763353088) and #1166’s Done when.
- **Settling the gate’s choices with scrum-master and critic first (design note `sprint4/1166-budget-design-r1.md`, r1–r3) was the right order.** 4a (CI gates only the element count; the Mac gates time) held through every later finding.
- **The PR queue outgrew the person’s review capacity:** 16–19 labeled PRs waiting by the 13:45 and 15:46 stand-ups, with no merges from 09:40 to about 17:00. The cap the brief planned for (4) was lifted, and nothing replaced it.
- **#1075’s priority was right but slipped once:** the person’s 08:48 changes request sat while I worked on #1185, until scrum-master’s 09:42 stand-up named it first.

## 3. Execution: where work flowed, where it waited

- **#1075 (the window, W1–W3) shipped:** merged 17:30 on 10 Nov at `7c7fea25`, after rounds for the stray stub, the redrawn island (`bd86d9d7`) and focus on rejoin, each with its repro as a failing case. The Firefox table on the PR (lead-measure, then tester’s Mac reference) showed opening a 10,000-item room going from about 1.8 s to about 35 ms.
- **#1168 (`--pane-w` with `inherits: false`) went from issue to merge in about two hours**, with a failing restyle count (1,580 to 29 elements) and a Firefox timing on the Mac (17 ms to 2 ms).
- **My own spec broke another PR’s CI.** #1168’s `pane-width-restyle-cost` waited for 1,000 mounted items, which failed on #1075 merged with `main` until `3132a077` opened its room whole. I should have run it with the window on before #1168 merged.
- **The budget spec (#1185) found its own probe errors only through Mac runs:** late Event Timing entries counted as 16 ms, Chromium’s full headless mode not presenting composer frames, keys paced faster than the budget, a 120 Hz display failing the calibration, and start-up timed over a pending snapshot (`009da21e`, from tester’s controls). Each was right to fix, but every “key to paint 16 ms” before `e9d849b0` was void and had to be retracted.
- **A false regression nearly held #1075:** tester’s first start-up control used an older `main`. Critic pulled the label, and tester’s controlled rerun cleared it (#1075, issuecomment-6771720726). Checking the control’s base commit first would have saved two hours.
- **My own slips:** I quoted two commit hashes from memory, both wrong, before copying `3d22a76a` from `git log` (my messages to critic, it_jtVRhRIG and after). I also pushed a test commit whose header was over the lint limit, and fixed it with a lease.

## 4. Postbox itself: what slowed the room

- **Queued messages arrive as one batch,** often repeating the same content two or three times (researcher’s 14:02 profile message came twice), which costs reading time and makes it easy to answer stale requests.
- **Long messages are cut at 2,000 characters in the turn’s summary,** so critic’s and lead-state’s key findings had to be fetched with `read_message`. Twice the ids I was given came back with “nothing to read”.
- **Background monitors that expire with no events wake the agent for nothing:** about eight expired-watch notices in a row during the 100,000-item run on 10 Nov, each a turn.
- **The server can’t build `/api/state` past about 100,000 items** (`RangeError: Invalid string length`, `server/index.mjs:262`), and a snapshot of a 10,000-item state blocked it long enough to skew start-up by 1.5 s. Both are #1155’s store work.
- **Postbox ran out of memory twice during the afternoon** (#1210), which, with the 403, ended the sprint early.

## 5. For the next sprint, in order

1. **Hold the room to the person’s merge capacity:** no new code PRs while more than about 6 wait on the person, and agents spend the time on measurement, follow-ups and Mac checks instead.
2. **Check every comparison’s control before posting it:** the same base commit, the same order in the test process, the same machine, and a probe that measures what its name says. Two of this sprint’s biggest detours (my feasibility probe and the start-up regression) were controls that weren’t.
3. **Put #1185 into CI properly:** its “new and changed specs, ten times” job fails with “No tests found”, because the spec is skipped unless `POSTBOX_BUDGET` is set. Add a CI job at 1,000 and 10,000 items that gates the element count now that #1075 has merged, and teach the ten-times job to set the variable or skip a spec with no tests.
