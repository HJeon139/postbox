# Inbox room: what the inbox changes, measured against main

- persona: A lead with four agents on a small release. Sends exactly the messages the phases give, word for word, and adds nothing to them. Answers Allow on any card that asks to allow another wake, and nothing else.
- agents: researcher, critic, developer, alpha
- backends: critic=codex:gpt-6-luna, developer=antigravity-cli:gemini-3.8-flash-high, alpha=kiro-cli:qwen3-coder-next
- steps: 30
- conversation: Release 2.1

A measuring scenario for the inbox’s build (designs/rooms-at-scale.md, “What the build must show”), and a compatibility run: @researcher runs on Claude Code, @critic on Codex, @developer on the Antigravity CLI and @alpha on the Kiro CLI. It makes the things the inbox is meant to change happen on purpose: a hand-off between agents, a second message while an agent works, a line copied from the conversation, and messages for one agent in two threads. Every message is given word for word, so a run on `main` and a run on the branch under test get the same input. Each message @-mentions only the agent it is for: your own @-mention wakes an agent, so a message that named the critic or the developer with an @ would wake them itself, and no hand-off between agents would be measured (the first run of this scenario did that).

Run it at least three times on each side, since one pair proves nothing:

`node tools/uat-run.mjs --scenario inboxroom --compat --budget 2 --max-cost 8 --file no --verify no`

Then count both sides from their run folders, which runs no agent:

`node tools/uat/inbox-measures.mjs --main <run folder>… --branch <run folder>…`

What it doesn’t cover is a session started on `main` and resumed on the branch, which takes two builds and one data folder. Do that by hand: start Postbox on `main` with a data folder of its own, and ask @researcher, on Claude Code, to hand one task to @critic. Stop Postbox. Start the branch under test on the same data folder, and send `@researcher Hand the same task to @developer now.` The session resumes with the guide it started with, which may name a tool the branch no longer has. Record whether @developer was woken, and what any call to `wake_agent` returned.

## Phase 1: A hand-off down a chain, then a second message while an agent works

Send this message, then wait until no agent is working:

`@researcher Write one sentence saying what release 2.1 changes: it adds search to the conversation. Then hand it to the critic to check the sentence, and ask the critic to hand it to the developer to say which file a changelog entry goes in.`

Say which agents replied, in what order, and whether any agent replied without being asked to.

Then send these two messages one right after the other, without waiting for a reply to the first:
1. `@developer List three things a release checklist should have. Take your time and number them.`
2. `@developer Also say which of the three you would do first.`

Wait until @developer has stopped working. Say whether its replies answer both messages, and whether it answered the first as if the second hadn’t been sent.

## Phase 2: A line copied from the conversation, then messages for one agent in two threads

Send this message, then wait until no agent is working:

`@alpha Find the newest message in this conversation that an agent other than you posted. Reply with its id and its exact text, as read_conversation gives that line, and nothing else.`

Say whether any agent replied after @alpha did. Nothing asked another agent for anything, so a reply from one is a wake by the copied line.

Then open a topic thread on @researcher’s first reply, and send this message in the thread:

`@critic In this thread only: is “adds search to the conversation” clear enough for a changelog? Answer in one sentence.`

Right after it, without waiting, go back to the conversation and send:

`@critic Here in the main conversation: what version number comes after 2.1? Answer with the number only.`

Wait until @critic has stopped working. Say where each of its answers was posted, the thread or the conversation, and whether each answer is in the place its question was asked.

## Phase 3: What each agent was asked

Send these four messages, each as its own message, waiting for the reply before the next:
1. `@researcher In one line, list what you were asked in this conversation. Name no other agent with an @.`
2. `@critic In one line, list what you were asked in this conversation and its thread. Name no other agent with an @.`
3. `@developer In one line, list what you were asked in this conversation. Name no other agent with an @.`
4. `@alpha In one line, list what you were asked in this conversation. Name no other agent with an @.`

After each, say whether the list leaves out anything the agent was asked. Then say, for the whole run, whether any message addressed to an agent went unanswered.
