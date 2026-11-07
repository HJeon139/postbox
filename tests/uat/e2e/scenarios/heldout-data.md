# Held-out experiment, the person’s data, with the skill

- persona: The owner of a small neighborhood restaurant who is thinking of raising prices and has last quarter’s orders for every dish. Practical, writes short messages, and wants a straight answer before the details.
- agents: developer
- models: persona
- judge: visual
- seed: visual-skill
- files: heldout-data
- steps: 6
- project: Restaurant
- conversation: Menu prices

This measures how an agent explains with a picture on one of the held-out briefs (designs/skills/visual-explainer/briefs/heldout/), written apart from the skill’s tuning for the experiment on the visual mechanisms. **With the skill:** the draft visual-explainer skill (designs/skills/visual-explainer) sits in the project as a Claude Code project skill (`- seed: visual-skill`). The files are already in the project folder. The runs are scored afterward, with the takeaway test on the first visual’s screenshot; your job is to ask as this person would. Don’t name a chart type, a library, Postbox’s tools, the word “app” or the skill, and don’t point the agent at a file by name.

## Phase 1: Ask

Send, word for word: “I’m thinking of raising our prices. Last quarter’s orders for every dish are in this folder. Do our pricier dishes sell worse?” Then wait until the agent has finished and its visual is on screen.

Pass if a visual is on screen. Note, without failing the phase, whether it’s an app, a Markdown diagram or a table, and what it shows first.

## Phase 2: One follow-up

Ask, word for word: “So if I put every main up by two dollars, what happens?” Then wait for the reply.

Pass if the agent answers by pointing at the visual or changing it. Note whether it answered from the picture or only in prose.
