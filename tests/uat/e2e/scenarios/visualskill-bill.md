# Visual skill, how a bill becomes law, with the skill

- persona: A high-school civics student studying for a test on how a US federal bill becomes law. Writes short messages, and can’t say what a good picture looks like until they see one.
- agents: researcher
- models: persona
- judge: visual
- seed: visual-skill
- steps: 6
- project: Visual skill
- conversation: How a bill becomes law

This measures the draft visual-explainer skill ([#207](https://github.com/HJeon139/postbox/issues/207)) on one of its starter briefs (designs/skills/visual-explainer/briefs/). **With the skill:** the draft visual-explainer skill (designs/skills/visual-explainer) sits in the project as a Claude Code project skill (`- seed: visual-skill`). The runs are scored afterward, with the takeaway test on the first visual’s screenshot; your job is to ask as this person would. Don’t name a chart type, a library, Postbox’s tools, the word “app” or the skill.

## Phase 1: Ask

Send, word for word: “Can you explain to me, visually, how a bill becomes a federal law and what can stop it? Here’s what my textbook says: a member of Congress introduces it and it goes to a committee; the chamber votes, then the other chamber does the same, and both have to pass the same version; then the President signs it or vetoes it, and two-thirds of each chamber can override a veto; if the President doesn’t act within ten days, not counting Sundays, it becomes law anyway, unless Congress has adjourned, which is a pocket veto.” Then wait until the agent has finished and its visual is on screen.

Pass if a visual is on screen. Note, without failing the phase, whether it’s an app, a Markdown diagram or a table, and what it shows first.

## Phase 2: One follow-up

Ask, word for word: “What happens if the President does nothing?” Then wait for the reply.

Pass if the agent answers by pointing at the visual or changing it. Note whether it answered from the picture or only in prose.
