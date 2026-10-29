# Coordination rules for #508

How the agents working on #508 coordinate across Claude Code, Codex and Antigravity. The person approved these rules on 28 October 2026, in the “rearchitecture-508” room, after each bug they rest on was checked against that room’s event log and the agents’ session logs.

Each rule names its evidence:
- **Seen:** it happened in that room’s logs.
- **In code:** certain from `main`, though not hit in the room yet.
- **Guard:** unconfirmed, and cheap to follow.

Drop a rule once its cause is fixed, in the same change that fixes it.

## Roles

1. **Only developer writes outside Postbox:** pushes, PRs and GitHub comments, each after a review block the person approves. gemini and gpt review and report in the room. (#400, seen: gemini runs in Run everything with publishing off, and nothing enforces that setting.)
2. **One shared checkout, read-only for reviewers.** Developer updates `postbox-ctx` to `origin/main` before each round and names the commit. Reviewers don’t run `git checkout`, `fetch` or `reset` in it. (Seen: gemini ran `git checkout origin/main` there during a review.)
3. **Findings that cite code give the file, line and commit,** and say when the code is on a branch. (Seen: gemini cited `fix/466-wake-retry` as if it were `main`.)

## Rounds

4. **The person starts each round,** naming every reviewer in one message. Reviewers post findings without mentioning developer, and developer folds them in once all have answered. (#492, in code: `PAIR_LIMIT` is 2, so a third wake between two agents always waits for the person’s Allow.)
   **For steps in progress,** the hand-offs in `execution-plan.md`, “How the room talks”, replace this rule: developer’s “ready for review” starts the round, and a reviewer mentions developer only for blocking findings. Each is one reply wake, under the pair limit.
5. **Mention an agent only when it must act next;** acknowledge with a reaction. (#331, #481)
6. **Work in the main conversation, not in topic threads,** until #511 and #507 merge. (#504 and #507, in code: a thread’s catch-up keeps only its newest 20 items and puts the room first.)
7. **No scheduled wakes for coordination** until #498 and the fix for #466 merge. (In code: they can’t be canceled, and one lost to a network drop isn’t retried.)

## Conversations

8. **Each plan step gets a new conversation,** with the design and that step’s issue as its brief. (#515, in code: a resumed Claude session keeps its first guide. #425: Postbox doesn’t call Codex’s `thread/compact/start` yet, though Codex 0.164.0 has it.)
9. **A step starts only once the PRs it waits on are merged:** #511 and #496 before “Now”; #451 and the #466 branch before A1 and A2; #513 before A2; #509 before B1; #495 before B3.

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
