# Room recall: finding one earlier item in a long room, on four harnesses

- persona: A lead who comes back to a long room and asks each agent to find one thing that was said far back. Sends exactly the messages the phases give, one at a time, and adds nothing to them.
- agents: researcher, critic, developer, alpha
- backends: critic=codex:gpt-6-luna, developer=antigravity-cli:gemini-3.8-flash-high, alpha=kiro-cli:qwen3-coder-next
- seed: big-room
- steps: 20
- conversation: The release, in a long room

A measuring scenario for #1340, and a compatibility run: @researcher runs on Claude Code, @critic on Codex, @developer on the Antigravity CLI and @alpha on the Kiro CLI. The room is seeded with about 1,000 generated items (`tools/uat/big-room.mjs`), so each agent joins with only its newest items in its catch-up, and what it is asked about is far behind them. Each agent gets its own question, so no agent can answer from another’s reply, and every item asked for is one of the person’s notes: an agent’s seeded reply starts with its @handle, and a reply that quotes it wakes that agent (the first run of this scenario woke two agents that way). Run it on `main` and on the branch under test with the same messages, and compare, for each agent’s turn, the tokens its harness reports and whether its answer is right:

`node tools/uat-run.mjs --scenario roomrecall --compat --budget 2 --max-cost 8 --file no --verify no`

What it measures is narrow on purpose: the cost and the correctness of finding one item by its words. It says nothing about how often a real room needs that.

## Phase 1: One item each, at four depths

Send these four messages, each as its own message, waiting for the agent’s reply before the next. Send them word for word:

1. `@researcher Find item 136 of the release log in this conversation. Reply with its id and its exact text, and nothing else.`
2. `@critic Find item 414 of the release log in this conversation. Reply with its id and its exact text, and nothing else.`
3. `@developer Find item 680 of the release log in this conversation. Reply with its id and its exact text, and nothing else.`
4. `@alpha Find item 880 of the release log in this conversation. Reply with its id and its exact text, and nothing else.`

After each reply, say whether it gives an id of the form `it_big` followed by the item’s number, and a text that names that item number. Don’t help an agent that can’t find its item, and don’t ask again.

## Phase 2: A second question, once each agent has looked

Send these four messages the same way:

1. `@researcher What did this conversation decide about how 2.0 ships? Reply with the decision’s id and its exact text, and nothing else.`
2. `@critic What are the steps in release-plan.md, the draft reviewed near the start of this conversation? Reply with the steps, and nothing else.`
3. `@developer Which checklist did the very first message of this conversation ask about? Reply with that message’s id and its exact text, and nothing else.`
4. `@alpha Find item 256 of the release log in this conversation. Reply with its id and its exact text, and nothing else.`

After each reply, say whether it answered from the conversation or said it couldn’t find it. Then say, for the whole run, which agents found what they were asked for and which didn’t.
