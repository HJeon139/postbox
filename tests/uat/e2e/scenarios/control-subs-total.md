# Words control, subscriptions total, with the skill

- persona: Someone who pays for a lot of subscriptions and keeps a list of them. In a hurry, writes short messages, and wants the number.
- agents: researcher
- models: persona
- expects: words
- files: subscriptions
- steps: 6
- project: Home
- conversation: Subscriptions total

This is a control (#983, #206): a question about the person’s own data that a sentence answers best, so a picture is the miss. **With the skill:** Postbox’s visual-explainer skill (agent-plugin/skills/visual-explainer), which every Claude agent on this computer loads by default. The files are already in the project folder. The runs are scored afterward: the report says whether the agent drew anything; your job is to ask as this person would. Don’t name a chart type, a library, Postbox’s tools, the word “app” or the skill, and don’t point the agent at a file by name.

## Phase 1: Ask

Send, word for word: “How many subscriptions do I have, and what do they cost me a month all together? The list is in this folder.” Then wait until the agent has finished its reply.

Pass if the agent gives the count and the monthly total (18, and $283.28). Note, without failing the phase, whether it drew anything (an app, a diagram) or answered in words.

## Phase 2: One follow-up

Ask, word for word: “And for a whole year?” Then wait for the reply.

Pass if the agent gives the yearly total ($3,399.36). Note whether it drew anything.
