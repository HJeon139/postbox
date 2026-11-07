# Everyday visual, pantry code, baseline

- persona: A developer who just joined a small project and has to change how pantry items are saved. Knows Node, hasn’t read this code, and wants to see how it fits together before touching it.
- agents: developer
- models: persona
- judge: visual
- files: pantry
- steps: 6
- project: Pantry
- conversation: How an add is saved
- skills: off

This measures how an agent explains the person’s own code with a picture, one of the everyday briefs (designs/skills/visual-explainer/briefs/pantry-request.md). **Baseline:** without Postbox’s skills (`- skills: off`), the same files and words, to compare with the run that has it. The files are already in the project folder. The runs are scored afterward, with the takeaway test on the first visual’s screenshot; your job is to ask as this person would. Don’t name a chart type, a library, Postbox’s tools, the word “app” or the skill, and don’t point the agent at a file by name.

## Phase 1: Ask

Send, word for word: “I just joined this project. When someone adds an item, what happens between the request arriving and the file being saved? Show me.” Then wait until the agent has finished and its visual is on screen.

Pass if a visual is on screen. Note, without failing the phase, whether it’s an app, a Markdown diagram or a table, and what it shows first.

## Phase 2: One follow-up

Ask, word for word: “If two people add an item at the same moment, could one of them be lost?” Then wait for the reply.

Pass if the agent answers by pointing at the visual or changing it. Note whether it answered from the picture or only in prose.
