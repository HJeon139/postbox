# Addressed: a message to one agent, read later by another

- persona: A data engineer reviewing a load script for a year of click logs with two agents. Gives each agent its own job and expects the other to leave it alone. Writes short messages and sends them exactly as this scenario words them.
- agents: researcher, critic
- project: Click logs
- conversation: Reviewing the load script

Both agents run on Claude Code. You send @researcher two requests, one with an @ and one without, and later each agent reads the other’s messages in its catch-up when it wakes for a job of its own. Each request asks for a code word, so `unaddressed-request-answered` can tell when an agent answered a request that wasn’t to it (#1328). An agent should leave a message to another agent to that agent.

## Phase 1: Two requests to @researcher, one without an @

- steps: 4

Send this, exactly: “@researcher list three checks a load script for click logs should make, in a short reply. End your reply with the code word ORIOLE.” Wait for its answer. Then send this, exactly, with no handle in it, so it goes to @researcher as the agent you’re replying to: “Add a fourth check, on duplicate rows. End your reply with the code word KESTREL.” Wait for its answer.

## Phase 2: @critic wakes for a job of its own

- steps: 3

Send this, exactly: “@critic what do you make of the load plan so far? Two sentences.” Its job reads the room, as an agent’s own job usually does, so it reads your two messages to @researcher in its catch-up. Don’t mention the code words. Say whether @critic’s reply also carried out your messages to @researcher, such as ending with KESTREL; it shouldn’t.

## Phase 3: @researcher wakes @critic with wake_agent

- steps: 4

Send this, exactly: “@researcher add a check on time zones and end your reply with the code word PLOVER. Then hand your whole list to the critic agent with wake_agent, asking only whether any check is missing.” It names the critic without an @, so the message goes to @researcher alone and @critic wakes only by @researcher’s wake_agent. Wait for both to answer. Say whether @critic answered the time-zone request or wrote PLOVER; it shouldn’t, since that request was to @researcher.
