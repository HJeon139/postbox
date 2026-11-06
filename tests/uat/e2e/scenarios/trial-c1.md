# Disguised archetypes, with the visual skill

- persona: A programmer who just joined a game team and has been handed a 256-row spreadsheet of how players’ choices map to titles. Writes short messages, and can’t say what a good picture looks like until they see one.
- agents: researcher
- models: persona
- seed: visual-skill
- steps: 6
- project: Team onboarding
- conversation: Title system

This measures the draft visual-explainer skill ([#207](https://github.com/HJeon139/postbox/issues/207)) on the disguised version of its hard brief (designs/skills/visual-explainer/briefs/spore-archetypes.md, “The disguised version”): the same rules as Spore’s archetypes, with every name changed so the agent can’t recall the answer. The scenario’s name, project and conversation say nothing about the subject or the skill, because the agent sees its folder, which is named after the scenario, and the project’s name. **With the skill:** the draft visual-explainer skill sits in the project as a Claude Code project skill (`- seed: visual-skill`). Its baseline is [trial-c2](trial-c2.md). The runs are scored afterward, with the takeaway test on the first visual’s screenshot; your job is to ask as this person would. Don’t name a chart type, a shape, a library, Postbox’s tools, the word “app”, the skill, or the game this is modeled on.

## Phase 1: Ask

Send, word for word: “I’m new on a game team, and I’m trying to understand our title system. A character works four shifts: dawn, noon, dusk and night. Each shift worked earns one token: slate for forging, amber for weaving, jade for brewing. A shift skipped stays copper, and copper counts for nothing. At the end, your four tokens decide your title, and only the kinds count, not which shift gave them. One kind alone, or three of one kind plus anything, gives that kind’s pure title: slate is Torthorn, amber is Morward, jade is Veywick. Two kinds make a mix: slate and amber is Ulmwick, slate and jade is Dalford, amber and jade is Iverstead. All three kinds with one doubled: double slate is Fenmoor, double amber is Selstead, double jade is Kelwick. One of each kind plus a copper: the last token you earned decides. Four coppers is Halwick. The programmers have a 256-row spreadsheet of every combination and nobody can hold it in their head. Can you explain visually how a player’s choices decide their title?” Then wait until the agent has finished and its visual is on screen. If the agent asks what the one-of-each rule decides, answer that it decides the pure title of that kind.

Pass if a visual is on screen. Note, without failing the phase, what form it takes and what it shows first.

## Phase 2: One follow-up

Ask, word for word: “If I forge two shifts and brew two, in any order, where do I end up, and how close is that to Torthorn?” Then wait for the reply.

Pass if the agent answers by pointing at the visual or changing it. Note whether it answered from the picture or only in prose.
