# Pair work: a developer and a critic finish a task between them

- persona: A developer who hands a small task to two agents and goes back to their own work. Expects them to settle it between themselves and say when it’s done. Writes short messages, sends them exactly as this scenario words them, and answers nothing that isn’t a question only they can answer.
- agents: developer, critic
- project: Slugs
- conversation: A slugify helper
- steps: 10

A scenario for agents working together without the person, Claude Code only, judged by the tester (its phases name no triggers): @developer writes, @critic reviews, and each has to wake the other for the work to finish. It shows what a single-agent run can’t: a hand-off one agent makes to another, a reply that goes back to the agent it answers, a reply addressed to an agent with no block asked of it ([#1701](https://github.com/HJeon139/postbox/pull/1701)), and an exchange that ends once nothing is left to say, with no run of acknowledgments ([#1591](https://github.com/HJeon139/postbox/issues/1591)). Don’t relay anything between the agents: if one waits on the other, that is the finding. A run that stops at its turn bound (“--max-turns”, in report.md) fails phase 3, whatever the tester wrote.

`node tools/uat-run.mjs --scenario pairwork --max-turns 40 --budget 2 --max-cost 9 --file no`.

## Phase 1: One message, then wait

Send this, exactly: “@developer write slugify.py in this folder: slugify(title) makes a lowercase URL slug with hyphens, with five unit tests in test_slugify.py, and run them. When they pass, ask @critic to review it yourself. Fix what it finds and have it check again. Don’t wait on me: the two of you agree it’s done, then one of you tells me.” Then send nothing: the run waits until both agents have stopped.

Pass if @developer asked @critic for the review with no message from you, @critic’s review reached @developer, @developer changed the code or said why it wouldn’t, and one of them told you it’s done. Say how many turns each agent took, and whether either one asked you something it could have asked the other. Note, without failing the phase, each reply one agent addressed to the other: whether it reads as words (it should), or as a block, a form or a “draft” the other agent can’t answer.

## Phase 2: A change, with no handle

Send this, exactly, with no handle in it: “One more rule: an empty title gives ‘untitled’. Same as before: agree between you, then tell me.” Then send nothing: the run waits until both agents have stopped.

Pass if the rule is in slugify.py with a test for it, @critic looked at the change, and one of them told you. Say which agent took your message, and how the other came to hear of it.

## Phase 3: The exchange ended

Wait 60 seconds and send nothing, then look at the conversation from the last “done” back to your message in phase 2. Then send this, exactly: “@critic in one sentence, what did you ask the developer to change?”

Pass if the agents had stopped by themselves when you looked, and no more than three agent turns followed the last reply that did work (changed a file, ran the tests or reviewed). Fail the phase if they were still answering each other. Note, without failing the phase, each of those turns that only thanks or acknowledges the other, and how many there were. Say whether @critic’s answer matches what it asked for in phase 1.
