# How a pull request is reviewed

The integrator’s guide, written from what its reviews of #508’s pull requests caught (1 to 2 November 2026). Authors read it before asking for review, and readers follow it (`designs/508/execution-plan.md`, “Definition of done for a pull request”).

## How a review runs

1. State the concern in your own words. Read the PR’s overview and the issue. Write one line on what the PR claims to fix, and judge every finding against it.
2. Reproduce “fails first” yourself. Copy the new specs onto main and run them. They must fail, and for the reason the PR names. An author’s claim isn’t evidence until you’ve rerun it.
3. Probe like an adversary. Go through the checks below. For each one, try to build the input that breaks the change: a probe script, a mutant, a restart.
4. Check the PR against the others in flight. Look at what merged since it branched, and at the other open PRs: conflicts, duplicated helpers, seams.
5. Read for legibility and size. Compare Biome’s counts for main and the head, then read the new modules as a newcomer would.
6. Write it up and swap the label. Use the format at the end of this guide. Every claim cites a command and its exit code. Replace `ready for integrator` with `integrator approved` or `changes requested`.

## The checks

### Is the change tested?

**Does the test’s setup hide the bug?**

- How: Read the fixture before the assertions. A spec can pass only because its setup always provides the state the bug needs to be missing.
- Caught in #633. The room() fixture always set lastTurn, so no spec ran with it empty. After a restart it is empty, and answering one refusal no longer fell back to the next. The agent showed idle, which is #366’s own symptom.

**Delete a line: does anything fail?**

- How: For each guard, clear or branch the PR adds, delete it and run the whole suite. If everything still passes, that line is untested, whatever the PR body says.
- Caught in #632 and #633. Deleting rejectedOps(store).clear() left 177 specs passing, and the line hid a real stale-state bug. In #633, cutting threadsOf down to the agent’s own thread passed every spec, so side threads were never tested.

**Is every claim proved by a command?**

- How: A count of exactly 0, or a run that found nothing, says something about the harness until it’s explained. Ask how the spec could fail, and whether it ever has.
- Caught on #628. The CI failure it fixed never reproduced locally: 0 of 40 runs idle, and 0 of 30 with every core busy. So the evidence is a spec that slows each write by 50 ms and fails on the old teardown, not a green rerun.

### State and contracts

**What is in memory after a restart?**

- How: Find every Map, Set or field the change’s decision reads. Ask what it holds after a restart, a reload, or a Retry that changes the epoch. If the answer is “nothing”, derive it from the store instead.
- Caught in #633. rt.lastTurn is set only when a turn ends, so it is empty until the next turn ends.

**Who else relied on the old behavior?**

- How: When a function stops throwing, starts returning a promise, or changes shape, grep for every caller, and for every comment that describes the old behavior. A stale comment points at the reader nobody changed.
- Caught in #632. The release no longer throws for a rejected event, but the held view still did, under a comment saying it “throws here as it will at release”. While a hold lasted, every pending read of that thread threw.

**Do the docs promise more than the code does?**

- How: This matters most for security boundaries and for rules in AGENTS.md, which every later session follows. List every path the rule claims to cover, and check each one.
- Caught in #630. AGENTS.md said every path to the page goes through the new projection. Only /api/state and the live and backlog event frames did. The settings route, the create and update routes, and telemetry reports answer with state directly. That’s harmless now, but it becomes a leak once any state is private.

### Async and timing

**A function became async: does every caller await it?**

- How: Biome’s noFloatingPromises now fails this in the gate (#638). Still check that a void the PR adds means it: the promise can’t reject, or it shows its own errors.
- Caught after #628. The fixture’s done() became async, and 60 specs went on calling it bare. Every check passed. #635 fixed the calls, and #638 added the rule.

**“Waits for what’s in flight”: what starts after the wait?**

- How: Pause the code at each await on the way in, such as a stat or a read, then call the close. Whatever resumes afterwards still writes, unless it checks a closed flag.
- Caught in #629. A call paused inside queueFull’s stat held no claim and no append, so close() resolved at once. Released afterwards, the call wrote its record anyway. The doc said a caller could then safely remove the folders.

**Is a rejection handled when it happens, or only later?**

- How: A promise that rejects before any handler is attached counts as unhandled in Node, even if a .then is added later. The server has no unhandledRejection handler, so one brings it down. Attach the handler where the promise is created.
- Caught while writing #638. The three CLI adapters kept a stop’s promise and only read it when the CLI closed. A failed stop also left its turn waiting forever. The new spec caught it, even though the first fix had looked right.

### The pull request among the others

**Does it conflict with, or duplicate, work that just landed?**

- How: Run git merge-tree against main and against each open PR that touches the same files. Then ask whether a helper it adds now exists on main under another name.
- Caught in #629 and #632. #629 added a finish() teardown next to the done() that #628 had made async a day earlier, which would leave two teardowns. #632’s list of seams with #630 left out a conflict in server/live-streams.mjs.

### Legibility

**Is one decision made in two places?**

- How: Search the code for the rule the PR implements. If two files compute it, they will drift apart. Ask for one function that both call.
- Caught in #624 and #632. In #624, “the latest reply” was decided in two modules that disagreed in two cases. In #632, a rejected op’s record was built twice, with different error text each time.

**Did the PR shrink a file by splitting a concern, or by compressing it?**

- How: Sizes are a signal, not a target. Compare Biome’s counts for main and the head. Each new module should own one thing you can name, and come in under the defaults: 300 lines a file, 50 a function. Joined lines, dense one-liners and dropped names fail review even when Biome passes them. After a merge that shrinks a file, lower its ceiling.
- Done well in #633. server/card-needs.mjs holds one decision, which card an agent needs you for, and the eleven places that used to clear the need each became one line.

## The review comment

- First line: The head SHA you reviewed, and the verdict: approved or changes requested, with the one reason in a sentence.
- Does it fix the concern?: Judge it against the line from step 1, with your own rerun of the specs failing first.
- Blocking: Wrong behavior, a regression from main, or a false claim in a rule. Give the file and line, a probe or mutant that shows it, and a fix.
- Should fix: Real gaps that don’t block: an untested line, a missed caller, a missing seam.
- Separation of concerns: One concern per module, one decision in one place, nothing compressed, and the size comparison.
- Checked and sound: What you tried that held up. This shows what was covered, so the next reviewer doesn’t redo it.
