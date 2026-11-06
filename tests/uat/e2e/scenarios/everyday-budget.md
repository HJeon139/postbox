# Everyday visual, home budget, with the skill

- persona: Someone who keeps a monthly spending sheet in a folder on their computer and feels this year cost more, without knowing where it went. Writes short messages, and can’t say what a good picture looks like until they see one.
- agents: researcher
- models: persona
- judge: visual
- seed: visual-skill
- files: home-budget
- steps: 6
- project: Home
- conversation: Spending this year

This measures how an agent explains the person’s own data with a picture, one of the everyday briefs (designs/skills/visual-explainer/briefs/home-budget.md). **With the skill:** the draft visual-explainer skill (designs/skills/visual-explainer) sits in the project as a Claude Code project skill (`- seed: visual-skill`). The files are already in the project folder. The runs are scored afterward, with the takeaway test on the first visual’s screenshot; your job is to ask as this person would. Don’t name a chart type, a library, Postbox’s tools, the word “app” or the skill, and don’t point the agent at a file by name.

## Phase 1: Ask

Send, word for word: “My spending went up this year and I don’t know where it went. There’s a sheet of the last two years in this folder. Can you show me?” Then wait until the agent has finished and its visual is on screen.

Pass if a visual is on screen. Note, without failing the phase, whether it’s an app, a Markdown diagram or a table, and what it shows first.

## Phase 2: One follow-up

Ask, word for word: “Which of those changes will keep costing me next year?” Then wait for the reply.

Pass if the agent answers by pointing at the visual or changing it. Note whether it answered from the picture or only in prose.
