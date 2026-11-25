# Profile: you say who you are, and both agents know

- persona: A staff engineer setting Postbox up on their own computer, who wants agents to address them properly and to know which names elsewhere are theirs. Writes short messages, sends them exactly as this scenario words them, and reads each reply for whether the agent used what it was told.
- agents: developer, critic
- project: Notes
- conversation: Getting set up
- steps: 10

A local run on one computer, Claude Code only: the one person is the account Postbox runs as (#558). The profile action writes into Settings › Profile through the page and saves, as a person would. What an agent is told is in each turn it is given, so the phases ask the agents and code triggers read their prompts, before the first save and after it: a run that never saved a profile fires neither and reads as a gap in coverage, not a pass.

`node tools/uat-run.mjs --scenario profile --max-turns 30 --budget 2 --max-cost 8 --file no`.

## Phase 1: Before anything is saved

- triggers: profile-untold-before-save
- steps: 2

Send this, exactly: “@developer in one sentence: what do you know about who I am, and what should you call me?”

Pass if @developer says it knows nothing about you beyond this conversation, or calls you “the person” or “you”. If it names you from its own folder’s path or git’s settings and says that’s where it’s from, note it and pass: that is the agent’s computer, not Postbox. Fail the phase only if it gives a name it says Postbox told it. What Postbox sent is judged by the trigger, which reads the turn @developer was given: nothing is saved yet, so it has no part about you.

## Phase 2: Save a profile, and ask each agent

- triggers: profile-told
- steps: 5

Use the profile action with these fills: Name “Robin”; Also written as “github: robin-example”; Pronouns “they/them”; Preferences “Short replies. American spelling.” Read what the tab says agents are told and say whether it matches what you wrote.

Then send this, exactly: “@developer in one sentence: what should you call me, and what’s my GitHub login?” When it has answered, send this, exactly: “@critic the same question: what should you call me, and what’s my GitHub login?”

Pass if both agents answer Robin and robin-example, and @developer hadn’t been told either in the conversation. @critic can read @developer’s answer in the room, so the trigger’s evidence, one line per agent, is what shows each was told. Say whether either agent still wrote “the person” where your name would read better, without failing the phase for it.

## Phase 3: Clear a field

- steps: 3

Use the profile action with this fill: Pronouns “” (empty, which clears it). Read what the tab says agents are told: it should no longer have a Pronouns line.

Then send this, exactly: “@critic in one sentence: what pronouns should you use for me? If you weren’t told, say so.”

Pass if the tab no longer has a Pronouns line. Note what @critic answers without failing the phase for it: its session was told “they/them” earlier, and a cleared field isn’t taken back from a turn already given. A new conversation starts clean.
