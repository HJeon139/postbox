# Coordination rules for #508

How the agents working on #508 coordinate across Claude Code, Codex and Antigravity. The person approved these rules on 28 October 2026, in the “rearchitecture-508” room, after each bug they rest on was checked against that room’s event log and the agents’ session logs.

Each rule names its evidence:
- **Seen:** it happened in that room’s logs.
- **In code:** certain from `main`, though not hit in the room yet.
- **Guard:** unconfirmed, and cheap to follow.

Drop a rule once its cause is fixed, in the same change that fixes it.

## Roles

1. **Every author’s writes outside Postbox** (pushes, PRs and GitHub comments) each follow a review or confirm block the person approves. This holds for developer, engineer, gpt and gemini (from 30 October 2026); critic and researcher post in the room, and push or comment only when the person asks directly. (#400, seen: gemini runs in Run everything with publishing off, and nothing enforces that setting.)
2. **One shared checkout, read-only for reviewers.** Developer updates `postbox-ctx` to `origin/main` before each round and names the commit. Reviewers don’t run `git checkout`, `fetch` or `reset` in it. (Seen: gemini ran `git checkout origin/main` there during a review.)
3. **Findings that cite code give the file, line and commit,** and say when the code is on a branch. (Seen: gemini cited `fix/466-wake-retry` as if it were `main`.)

## Rounds

4. **Dropped 30 October 2026:** “the person starts each round”. #541 (v0.44.7) removed the pair limit, and a chain now waits for the person only past 50 wakes, so the hand-offs in `execution-plan.md`, “How the room talks”, apply to every round.
5. **Mention an agent only when it must act next;** acknowledge with a reaction. (#331, #481)
6. **Work in the main conversation, not in topic threads,** until #511 and #507 merge. (#504 and #507, in code: a thread’s catch-up keeps only its newest 20 items and puts the room first.)
7. **No scheduled wakes for coordination** until #498 and the fix for #466 merge. (In code: they can’t be canceled, and one lost to a network drop isn’t retried.)

## Conversations

8. **Each plan step gets a new conversation,** with the design and that step’s issue as its brief. (#515, in code: a resumed Claude session keeps its first guide. #425: Postbox doesn’t call Codex’s `thread/compact/start` yet, though Codex 0.164.0 has it.)
9. **A step starts only once the PRs it waits on are merged:** #511 and #496 before “Now”; #451 and the #466 branch before A1 and A2; #513 before A2; #509 before B1; #495 before B3.

## Terms

12. **Define cryptic terms in the Postbox glossary** (from 30 October 2026). The first time a coined or cryptic term appears in a message, block, issue or PR body, call `define_term` for it. Code identifiers in backticks need an entry only when the idea behind them is new; GitHub text defines a term in a sentence instead.

## Quality (from 31 October 2026)

These come from what recurred in this room’s reviews: the lock needed three defect reports and 1a seven reproduced defects across four reviewed heads, a check could not fail, a claim had no source, a decision moved under a PR, and Codex went nine days without its instructions. Principles that apply beyond this room (publish whole or not at all, one failure policy, checks that can fail for the stated reason) are in `designs/developing.md`, “Design habits”.

13. **Invariants and a failure table before code.** For anything concurrent, durable or security-relevant, the design step lists its invariants, the interleavings that must hold, and what is on disk, what a concurrent reader sees and what the person sees after a kill at each step (`storage-design.md`, “Crash points”), including a row for a reader that sees the thing half-made. The design text is read against that table, and the rule binds a reviewer’s own proposal as much as the author’s. (gpt approved a lock design with no row for a concurrent reader.) critic reads the list before the code, in this order: the requirement ids and the `intent.md` line; the decision log and open questions; the invariants and table; the tests (failing first on the baseline for the stated reason, a counterexample for any validator, a test of the receiver at the level claimed); a short pre-mortem. Its output is one page, go, go with conditions, or not ready, at most ten findings. (Seen: the lock section of our own design specified create then fill, and the table had no row for a half-written file.)
14. **Report and fix the class, ending in the cheapest permanent check.** A reviewer names the class with the instance. The fix adds a pattern sweep: the sibling places searched (every path that creates then fills, every failure path, every slice of text by code units, every second surface such as the panel and the main view), and the one test or lint that covers the class, tried in several orderings. (Seen: #422 fixed for the main view and missed in the panel, then #360.)
15. **Claims need evidence, and decisions, premises and heads are re-read.** Every statement in a PR body, provenance file or design text points to a file, line, hash or run, produced by the command and not typed from memory. A design change updates its sister documents in the same commit. Before porting anything, check on `main` whether the reason it was written still holds, whether `main` already provides it, and whether the port adds a second source for the same fact. Before pushing, re-read the decision log and open questions. An approval names the head it covers, and critic’s read counts on the latest head before the push is asked for. (Seen: hashes promised and absent; five disagreements between #580 and #581; 1a built Retry as a reload after the integrator moved it to 1b; ports from the Redis branch the recalled design did not need.)
16. **Prove delivery, not sending.** Anything that must reach an agent, backend or page has a check on the receiver’s side, and every adapter handles a session it cannot load. (Seen: #584, #585, #587.)
17. **Think about the operator.** Upgrade, downgrade, logs, the data on disk, release notes, rollback, permissions and secrets, and the second surface (panel and main view, remote and local). Work in temp folders (`mkdtemp`), never in `~/.postbox` or a shared checkout, and sanitize recorded fixtures (host names, install ids, paths) before staging. (Seen: a benchmark that read `~/.postbox`; fixtures with a host name and an install id; the 1.6.0 notes silent about protocol 2 hosts, #583.)
18. **Say what is unverified.** An unrun check or an untested backend is named as such. Nobody, reviewers included, calls something safe without trying it. (Seen: a mutex called non-blocking and an older Postbox said to truncate at an array line, neither tried.)

## Guards

10. **An agent that doesn’t answer:** read its last turn’s error before mentioning it again. (#396; #335’s stale quota error hadn’t recurred since 25 October.)
11. **A turn that should have reported but shows no text:** ask the agent to post its result again. (#485, not confirmed in the room.)

## Checked, and no rule needed

- **#324:** gpt’s network calls are approved by Codex’s own reviewer, without a card.
- **#416:** gemini isn’t in Auto.
- **#338:** both gemini and gpt read files outside the project.
- **A resend after a failed turn** can repeat a prompt the backend already saved; Codex and Antigravity logs both show the prompt saved before any output. The design labels every resend, so nothing more is needed here.
- **Asking the person a question:** use Postbox’s choice and form blocks, not Claude Code’s `AskUserQuestion`, until #521 is fixed.

## Where rooms should keep rules like these

Postbox has no room notes yet, so these rules live here and in a message in the room. #14 and #516 (room assets) specify notes that reach every turn once the person approves them.
