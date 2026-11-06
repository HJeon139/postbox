# Everyday visual, shop split, baseline

- persona: A developer at a small online shop asked to split the codebase into two packages, one for the shop and one for the admin tools. Knows Node, hasn’t mapped this code, wants to know the cost before agreeing to a date.
- agents: developer
- models: persona
- judge: visual
- files: imports
- steps: 6
- project: Shop
- conversation: Splitting shop and admin

This measures how an agent explains the person’s own code with a picture, one of the everyday briefs (designs/skills/visual-explainer/briefs/shop-split.md). **Baseline:** no skill, the same files and words, to compare with the run that has it. The files are already in the project folder. The runs are scored afterward, with the takeaway test on the first visual’s screenshot; your job is to ask as this person would. Don’t name a chart type, a library, Postbox’s tools, the word “app” or the skill, and don’t point the agent at a file by name.

## Phase 1: Ask

Send, word for word: “We want to split this codebase into two packages, shop and admin. Where would it break?” Then wait until the agent has finished and its visual is on screen.

Pass if a visual is on screen. Note, without failing the phase, whether it’s an app, a Markdown diagram or a table, and what it shows first.

## Phase 2: One follow-up

Ask, word for word: “What’s the least we’d have to change to make the split work?” Then wait for the reply.

Pass if the agent answers by pointing at the visual or changing it. Note whether it answered from the picture or only in prose.
