# Dismiss a failed reply: say no to Retry

- persona: A product manager checking a launch plan with one agent, who reads replies quickly and moves on. When something goes wrong and the moment has passed, they’d rather clear it than run it again. Writes short messages.
- agents: researcher
- project: Launch plan
- conversation: Checking the launch plan

The agent runs on Claude Code. The fault launcher fails its first turn after this phase starts, before it writes anything, so its reply shows an error with Retry and Dismiss (#883). Dismiss it: the agent should stop asking for you, the error should stay readable, and nothing should run again.

## Phase 1: A failed reply you dismiss

- fault: fail-before-output researcher 1
- triggers: failed-reply-dismissed
- steps: 5

Ask @researcher for the two riskiest dates in the launch plan. Its turn fails before it writes anything. Don’t retry it: press Dismiss on the failed reply. Then say whether @researcher still shows as needing you, whether the error is still there to read, and which buttons the reply still has.

## Phase 2: Retry it after all

- steps: 4

You’ve changed your mind. Press Retry on the reply you dismissed. Say whether @researcher answers this time, and whether the dismissed reply now says it was retried below.
