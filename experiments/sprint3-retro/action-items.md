# Action items for sprint 4 (adopted 6 November 2026; draft for approval)

The person picked 7 of the 10 candidates (actions 1, 2, 3, 4, 5, 7 and 10), then added action 6 after revision 2 of the aggregate. Rules go into the sprint 4 working agreement on day one. Build items are groomed and estimated with the team like any other backlog item. Owners are proposals until grooming. Each measure states sprint 3's figure as its baseline.

Not adopted: 8 (day-sized slices; measure before carding) and 9 (owners and deadlines for questions between agents). Both stay in the aggregate as single-source points.

## Rules, in the working agreement from the start

| # | Action | Owner | Measure (sprint 3 baseline) |
|---|---|---|---|
| 1 | **UTC on every time,** in messages, blocks, notes, PR bodies and hand-backs. A local time may follow in brackets, with its zone written as an offset (UTC−8), never as a name like PST or PDT. | everyone; scrum-master checks | decisions moved by a wrong time: 1 (s3-826-after-freeze) |
| 4 | **Stack at most one deep.** No branch builds on an unmerged branch that itself builds on another. Rebase once, right before the final gate, and run the browser runs and the UAT on that head. When a base merges, retarget at once, then do what actually starts CodeQL on a retargeted PR. Until lead-delivery's finding is in, a close and reopen doesn't count: it didn't start CodeQL on #783. | every lead; lead-delivery finds the CodeQL trigger | most restacks of one PR: 7 (#808); median hours from open to merge: 11.9 |
| 5 | **Test design in the pre-review packet,** before critic sees the PR: <br>(a) for a PR that changes state or failure handling, the packet has a failure table, and each row has a test, written first, including “something else fixed it” and “the person did it, not Postbox”; <br>(b) grep every reader, writer and caller of a value the PR changes or starts to read, and rerun the grep after each fix; <br>(c) a hostile-input spec (`"`, `<`, `&`, NUL) and its mutant for each new path from agent text into HTML, a header or a file name; <br>(d) assert the exact outcome shown, not only that the old one is gone; <br>(e) every measurement proves its instrument on each run, with a calibration and a mutant that empties it; <br>(f) mutate every condition on the changed lines, not only the new guards. | authors; critic checks the packet | PRs sent back by the integrator: 12 (15 change requests) |
| 6 | **A Mac check before sign-off** for any PR that touches temp folders, sockets, browser specs or timing: researcher runs the named tests on the Mac, plain and lagged, on the exact head, and posts the counts before critic signs off. | researcher; critic checks it was run | send-backs for macOS-only or fast-machine cases: 3 (#802, #777 at `cb64d995`, #775) |

## Build items, groomed for sprint 4

| # | Action | Owner | Measure (sprint 3 baseline) | Tracked as |
|---|---|---|---|---|
| 2 | **A read-only allow list** for review commands (`gh pr checks/view/diff`, `git fetch/merge-tree/archive/rev-list/ls-remote`), built on the generic allow list and after #817, because a mod can approve a call before Postbox's list sees it | researcher (draft), a lead to build | permission cards in one evening: 48, 44 of them git or gh | the generic allow-list draft (`as_Rfa1dRT`), to be re-read against #806 and filed after critic |
| 3 | **A shared gate and sign-off script in the repo** that talks. It waits for a load under 20 inside the lock and prints a line every minute. It checks the toolchain, runs Biome on each commit, runs `merge-tree` against a fresh `main`, and runs Biome on the merged tree. It reads `gh pr checks`, CodeQL included, and takes spec lists as arrays. It exits non-zero on any failure, and prints one summary line (head, load, counts) for the hand-back to quote. | critic and lead-transcript | sign-offs posted over a failure: 1 (#770's `merge-tree` conflict); gates that reported 0 on a failure: 1 (exit 69) | a new issue (draft below) |
| 7 | **Cited commits are on GitHub, checked by script.** Every SHA in a design note, PR body or hand-back must be reachable from a remote ref (`git branch -r --contains`). A hand-back's facts are refreshed when it's posted, not when it's drafted. | lead-measure | cited SHAs not on GitHub: 3 in 2 PRs (#783 `6fd9c743`, then `99c15ffa`; #826 `ba196c81`); hand-backs asked again for stale facts: 1 (s3-777-handback-r2) | a new issue (draft below), or part of 3's script |
| 10 | **A quiet tool call on a Claude Code host keeps its turn.** Detaching a long run with `nohup` and a progress file is a rule now: #826’s detached rerun passed 573 of 573. Draft C fixes Postbox’s stall stop for the case it misses. | researcher (found the source: Postbox’s `checkStalls`); lead-transcript gives the evidence | background runs lost to a stopped turn: at least 3 (#775's lagged run at 493 of 566, #826's lagged run, a CI watcher) | a new issue (Draft C) |

## Issue drafts

### Draft A, for action 3: `tools: one gate and sign-off script that fails loudly and talks while it waits`

**Why.** In sprint 3 each lead and the reviewer ran their own gate and sign-off scripts, and those scripts failed quietly:
- A sign-off posted its label over a `merge-tree` conflict.
- A gate exited 69 inside a job that reported 0.
- A spec list passed as one shell word ran no tests.
- Waits that printed nothing for 15 minutes had their turn stopped.

**What.** One script under `tools/`, run by every author before asking for review and by the reviewer before a label. It:
- waits for the load to drop under the limit, inside the existing gate lock;
- prints a progress line at least every minute;
- checks the toolchain (both Node versions) and fails if one is missing;
- runs Biome on each commit;
- runs `git merge-tree` against a freshly fetched `main`, then Biome and the project lints on the merged tree;
- reads `gh pr checks`, CodeQL included, and fails on any red or missing required check;
- takes spec lists as arrays;
- exits non-zero on any failure;
- prints one summary line (head SHA, load, counts) to quote in a hand-back.

**Done when.** A mutant of each failure path (a conflict, a red commit, a missing toolchain, a missing check) makes the script exit non-zero, and a test shows it.

**Not in scope.** Changing the gate itself (`npm run check`, the browser runs).

### Draft B, for action 7: `tools: check that every commit a note or PR body cites is on GitHub`

**Why.** In sprint 3, two PRs cited commits that no remote ref held: a design note's “after” commit was a local scratch merge, and a full browser run was reported on an unpushed head. Each needed a correction round.

**What.** A check that reads a Markdown file or a PR body, finds each 7–40 character hex token with at least one letter a–f that `git cat-file -t` resolves to a commit, and fails if `git branch -r --contains <sha>` finds no remote branch. A token that doesn’t resolve is reported separately, as “not a known object”, and doesn’t fail the check. It can run on its own, and as a step of the gate and sign-off script (Draft A).

**Done when.** A test passes a body that cites one reachable and one unreachable SHA, and the check names only the unreachable one; and a body that cites the number `33554432` passes.

### Draft C, for action 10: `fix(remote): a quiet tool call on a Claude Code host doesn’t get its turn stopped as hung`

**Why.** Postbox stops a remote turn as hung when nothing new has arrived for the host’s `stallTimeout` (default 15 minutes, `shared/remote-settings.mjs:29`; the stop is `checkStalls` in `server/remote/turns-resume.mjs:21–35`). Kiro turns are excused while a tool call runs. Claude Code turns are not, because the code relies on Claude Code printing `tool_progress` heartbeats during a quiet tool call (`server/adapters/claude-code-remote.mjs:28–37`, `server/adapters/adapter.mjs:71–74`). In sprint 3, Claude Code turns on a host were stopped anyway while a command was still running. The stop cut a lagged browser run at 493 of 566 tests and ended another run before its first test. It also killed a CI watcher. Agents now write polling loops that print every few minutes only to keep the turn alive.

**What’s not known yet.** Why the heartbeats stopped. Two guesses, both unverified: the agent was waiting on a background task or a monitor rather than a foreground command, or the command ran past Claude Code’s own command time limit. The stopped turns’ lines (“Stopped: no output for 15 min (the last at …)”) and the host turn’s stream log would show it.

**What.** First find which case stops the heartbeats, from a recorded stream. Then do one of these, as the issue decides:
- count Claude Code’s open tool calls the way Kiro’s are counted;
- keep the heartbeats coming in the case that loses them;
- warn the agent before its turn is stopped for silence.

**Done when.** A recorded Claude Code stream of the failing case, replayed against `checkStalls`, no longer stops the turn while its tool call is open. Or, with the warning, the agent gets the warning before the stop.

**Workaround now.** Raise the host’s “Stop a quiet turn after” setting (`stallTimeout`, 10 minutes to 24 hours).
