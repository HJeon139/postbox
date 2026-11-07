# Held-out experiment, the person’s code, with the skill

- persona: The one developer who looks after the reminder texts for a small grooming shop. Knows Node, wrote none of this code, and has had complaints that customers got the same text twice. Wants to see how it works before changing anything.
- agents: developer
- models: persona
- judge: visual
- seed: visual-skill
- files: heldout-code
- steps: 6
- project: Reminders
- conversation: Double texts

This measures how an agent explains with a picture on one of the held-out briefs (designs/skills/visual-explainer/briefs/heldout/), written apart from the skill’s tuning for the experiment on the visual mechanisms. **With the skill:** the draft visual-explainer skill (designs/skills/visual-explainer) sits in the project as a Claude Code project skill (`- seed: visual-skill`). The files are already in the project folder. The runs are scored afterward, with the takeaway test on the first visual’s screenshot; your job is to ask as this person would. Don’t name a chart type, a library, Postbox’s tools, the word “app” or the skill, and don’t point the agent at a file by name.

## Phase 1: Ask

Send, word for word: “Some customers got the same reminder text twice last week. How does a reminder get from a booking to a text in this code? Show me.” Then wait until the agent has finished and its visual is on screen.

Pass if a visual is on screen. Note, without failing the phase, whether it’s an app, a Markdown diagram or a table, and what it shows first.

## Phase 2: One follow-up

Ask, word for word: “Would cutting the number of retries stop the doubles?” Then wait for the reply.

Pass if the agent answers by pointing at the visual or changing it. Note whether it answered from the picture or only in prose.
