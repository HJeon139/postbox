# Visual skill, Spore archetypes, with the skill

- persona: A programmer who just joined a game team and has been handed a 256-row spreadsheet of how players’ choices map to archetypes. Writes short messages, and can’t say what a good picture looks like until they see one.
- agents: researcher
- models: persona
- judge: visual
- steps: 6
- project: Visual skill
- conversation: Spore archetypes

This measures the draft visual-explainer skill ([#207](https://github.com/HJeon139/postbox/issues/207)) on its hard brief (designs/skills/visual-explainer/briefs/spore-archetypes.md): a system of rules whose true shape is hidden. **With the skill:** Postbox’s visual-explainer skill, which every Claude agent on this computer loads by default. The runs are scored afterward, with the takeaway test on the first visual’s screenshot; your job is to ask as this person would. Don’t name a chart type, a shape, a library, Postbox’s tools, the word “app” or the skill.

## Phase 1: Ask

Send, word for word: “I’m new on a game team, and I’m trying to understand our archetype system. A species goes through four stages: cell, creature, tribe and civilization. Each stage you finish gives you one token: red if you played it aggressively, blue if you played it neutrally, green if you played it kindly. A stage you skip stays white, and white counts for nothing. At the end, your four tokens decide your archetype, and only the colors count, not which stage gave them. One color alone, or three of one color plus anything, makes you that color’s pure archetype: red is Warrior, blue is Trader, green is Shaman. Two colors make a mix: red and blue is Scientist, red and green is Zealot, blue and green is Diplomat. All three colors with one doubled: double red is Knight, double blue is Bard, double green is Ecologist. One of each color plus a white: the last color you earned decides. Four whites is Wanderer. The programmers have a 256-row spreadsheet of every combination and nobody can hold it in their head. Can you explain visually how a player’s choices decide their archetype?” Then wait until the agent has finished and its visual is on screen.

Pass if a visual is on screen. Note, without failing the phase, what form it takes and what it shows first.

## Phase 2: One follow-up

Ask, word for word: “If I play two stages aggressively and two kindly, in any order, where do I end up, and how close is that to Warrior?” Then wait for the reply.

Pass if the agent answers by pointing at the visual or changing it. Note whether it answered from the picture or only in prose.
