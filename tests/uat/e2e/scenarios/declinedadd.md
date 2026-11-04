# Declined add: an agent you said no to, mentioned again

- persona: A data engineer reviewing a load script for a year of click logs with two agents, who wants to keep the conversation small. Decides quickly and doesn’t like being asked the same thing twice. Writes short messages.
- agents: researcher, critic
- project: Click logs
- conversation: Reviewing the load script

Both agents run on Claude Code. One agent writes the handle of an agent this conversation doesn’t have, with an @ in front, so Postbox asks you whether to add it. You say no. Then the other agent writes that handle the same way. Postbox shouldn’t ask you again: the agent that wrote it is told you said no (#693).

## Phase 1: An agent asks for another agent, and you say no

- steps: 6

Ask @critic to recommend, in its reply, that the developer agent review the load script, writing the developer agent’s handle with an @ in front of it. Don’t write that handle with an @ yourself. The developer agent isn’t in this conversation, so a card asks you whether to add it: don’t add it, and say what the card said.

## Phase 2: Another agent mentions it again

- triggers: declined-add-no-card
- steps: 6

Ask @researcher whether it agrees with @critic, and to say so in its reply with the developer agent’s handle written with an @ in front, the same way. No new card should ask you to add the developer agent, since you already said no. Say whether one did, and whether either agent still needs you.
