# Everyday visual, flaky tests, baseline

- persona: A developer at a small online shop whose tests fail at random and take long, and who has the last 200 runs summed up per test. Busy, writes short messages, wants the answer before the details.
- agents: developer
- models: persona
- judge: visual
- files: test-health
- steps: 6
- project: Shop
- conversation: Flaky tests

This measures how an agent explains the person’s own data with a picture, one of the everyday briefs (designs/skills/visual-explainer/briefs/flaky-tests.md). **Baseline:** no skill, the same files and words, to compare with the run that has it. The files are already in the project folder. The runs are scored afterward, with the takeaway test on the first visual’s screenshot; your job is to ask as this person would. Don’t name a chart type, a library, Postbox’s tools, the word “app” or the skill, and don’t point the agent at a file by name.

## Phase 1: Ask

Send, word for word: “Our tests fail at random and some of them are slow. The numbers from the last 200 runs are in this folder. Where should we start?” Then wait until the agent has finished and its visual is on screen.

Pass if a visual is on screen. Note, without failing the phase, whether it’s an app, a Markdown diagram or a table, and what it shows first.

## Phase 2: One follow-up

Ask, word for word: “If we fix just one thing, how many of the failures go away?” Then wait for the reply.

Pass if the agent answers by pointing at the visual or changing it. Note whether it answered from the picture or only in prose.
