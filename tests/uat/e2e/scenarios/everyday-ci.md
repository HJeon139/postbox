# Everyday visual, CI times, with the skill

- persona: A developer at a small online shop who noticed CI got slower and has a log of the runs. Busy, writes short messages, wants the answer before the details.
- agents: developer
- models: persona
- judge: visual
- seed: visual-skill
- files: ci-times
- steps: 6
- project: Shop
- conversation: Slow CI

This measures how an agent explains the person’s own data with a picture, one of the everyday briefs (designs/skills/visual-explainer/briefs/ci-times.md). **With the skill:** the draft visual-explainer skill (designs/skills/visual-explainer) sits in the project as a Claude Code project skill (`- seed: visual-skill`). The files are already in the project folder. The runs are scored afterward, with the takeaway test on the first visual’s screenshot; your job is to ask as this person would. Don’t name a chart type, a library, Postbox’s tools, the word “app” or the skill, and don’t point the agent at a file by name.

## Phase 1: Ask

Send, word for word: “Our CI got slow over the last month or so. The run times are in this folder. Where did the time go?” Then wait until the agent has finished and its visual is on screen.

Pass if a visual is on screen. Note, without failing the phase, whether it’s an app, a Markdown diagram or a table, and what it shows first.

## Phase 2: One follow-up

Ask, word for word: “If we fix just one thing, which one buys back the most?” Then wait for the reply.

Pass if the agent answers by pointing at the visual or changing it. Note whether it answered from the picture or only in prose.
