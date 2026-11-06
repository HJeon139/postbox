# Everyday visual, sleep and running, baseline

- persona: A runner who logs every run and how long they slept the night before, and has started to wonder whether sleep makes any difference. Curious, not a statistician, writes short messages.
- agents: researcher
- models: persona
- judge: visual
- files: running
- steps: 6
- project: Running
- conversation: Does sleep matter?

This measures how an agent explains the person’s own data with a picture, one of the everyday briefs (designs/skills/visual-explainer/briefs/running.md). **Baseline:** no skill, the same files and words, to compare with the run that has it. The files are already in the project folder. The runs are scored afterward, with the takeaway test on the first visual’s screenshot; your job is to ask as this person would. Don’t name a chart type, a library, Postbox’s tools, the word “app” or the skill, and don’t point the agent at a file by name.

## Phase 1: Ask

Send, word for word: “I’ve logged my runs and my sleep since April. Does sleep actually make me run faster? The log is in this folder.” Then wait until the agent has finished and its visual is on screen.

Pass if a visual is on screen. Note, without failing the phase, whether it’s an app, a Markdown diagram or a table, and what it shows first.

## Phase 2: One follow-up

Ask, word for word: “So how much sleep should I aim for before a long hill run?” Then wait for the reply.

Pass if the agent answers by pointing at the visual or changing it. Note whether it answered from the picture or only in prose.
