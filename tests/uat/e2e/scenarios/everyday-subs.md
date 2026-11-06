# Everyday visual, subscriptions, with the skill

- persona: Someone who pays for a lot of subscriptions, keeps a list of them with how often each got used, and suspects some aren’t worth it. Writes short messages, and can’t say what a good picture looks like until they see one.
- agents: researcher
- models: persona
- judge: visual
- seed: visual-skill
- files: subscriptions
- steps: 6
- project: Home
- conversation: Too many subscriptions

This measures how an agent explains the person’s own data with a picture, one of the everyday briefs (designs/skills/visual-explainer/briefs/subscriptions.md). **With the skill:** the draft visual-explainer skill (designs/skills/visual-explainer) sits in the project as a Claude Code project skill (`- seed: visual-skill`). The files are already in the project folder. The runs are scored afterward, with the takeaway test on the first visual’s screenshot; your job is to ask as this person would. Don’t name a chart type, a library, Postbox’s tools, the word “app” or the skill, and don’t point the agent at a file by name.

## Phase 1: Ask

Send, word for word: “I pay for way too many subscriptions and I suspect some aren’t worth it. My list, with how much I’ve used each one, is in this folder. Can you show me which ones are worth it?” Then wait until the agent has finished and its visual is on screen.

Pass if a visual is on screen. Note, without failing the phase, whether it’s an app, a Markdown diagram or a table, and what it shows first.

## Phase 2: One follow-up

Ask, word for word: “If I cancel three, which three save the most for the least I’d miss?” Then wait for the reply.

Pass if the agent answers by pointing at the visual or changing it. Note whether it answered from the picture or only in prose.
