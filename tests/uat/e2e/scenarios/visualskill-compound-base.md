# Visual skill, compound interest, baseline

- persona: Someone opening their first retirement account, who keeps hearing that compound interest is what matters and wants to see why. Writes short messages, and can’t say what a good picture looks like until they see one.
- agents: researcher
- models: persona
- judge: visual
- steps: 6
- project: Visual skill
- conversation: Why compound interest wins
- skills: off

This measures the draft visual-explainer skill ([#207](https://github.com/HJeon139/postbox/issues/207)) on one of its starter briefs (designs/skills/visual-explainer/briefs/). **Without the skill** (`- skills: off`): the baseline for [visualskill-compound](visualskill-compound.md), with the same persona and the same messages, and no skill in the project. The runs are scored afterward, with the takeaway test on the first visual’s screenshot; your job is to ask as this person would. Don’t name a chart type, a library, Postbox’s tools, the word “app” or the skill.

## Phase 1: Ask

Send, word for word: “Can you explain to me, visually, why compound interest ends up so far ahead of simple interest when the rate is the same? Say I put in $1,000 at 5% a year for 30 years: simple interest adds $50 a year, and compound adds 5% of whatever the balance is, once a year.” Then wait until the agent has finished and its visual is on screen.

Pass if a visual is on screen. Note, without failing the phase, whether it’s an app, a Markdown diagram or a table, and what it shows first.

## Phase 2: One follow-up

Ask, word for word: “Where does the gap between the two come from, and when does it start to matter?” Then wait for the reply.

Pass if the agent answers by pointing at the visual or changing it. Note whether it answered from the picture or only in prose.
