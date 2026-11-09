# Ask a question: an agent’s AskUserQuestion, answered in its turn

- persona: A small-business owner starting a side project, who likes to be asked rather than guessed for. Answers questions quickly and expects the agent to carry on with the answer. Writes short messages.
- agents: researcher
- permission_modes: researcher=auto
- project: Side project
- conversation: Naming the project

A targeted scenario for #521, Claude Code only, with @researcher on this computer in Auto. Claude Code’s own AskUserQuestion tool used to show as a permission card whose Allow sent back no answer. Now each question shows as a choice block, and the person’s pick is the tool’s result, in the same turn: no permission card, and no answer arriving later as a message. Watch for a permission card about AskUserQuestion, a refusal card, an agent that says it got no answer or asks again, and a reply that comes only after you send another message.

`node tools/uat-run.mjs --scenario askquestion --file no`.

## Phase 1: One question, answered in the turn

- triggers: question-answered-in-turn
- steps: 4

Ask @researcher to use its AskUserQuestion tool to ask you one multiple-choice question: which of three names it suggests to use for your new project. Once you’ve answered, it should write one line using the name you picked. When the question shows as a choice, pick one of its options. Then check that @researcher’s reply, without you sending anything more, uses the name you picked, and say whether you saw any permission card about AskUserQuestion, a refusal card, or an error.
