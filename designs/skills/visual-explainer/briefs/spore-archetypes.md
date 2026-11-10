# Spore: how play style decides a species’ archetype

The hard brief. The other briefs chart data points; this one is a system of rules whose true shape is hidden. Its designer, Stone Librande, first drew it as a radial tree that “makes a nice necklace” and was wrong, then as a half fan that was still disordered, and only found the triangle when he treated each choice as a vector ([“One-Page Designs”, GDC 2010, 35:00–44:00](https://www.youtube.com/watch?v=E9_wLks1kAg)). An agent that draws the rules as given will most likely repeat his first two attempts.

- **Idea:** Every stage played nudges the species one step toward one of three poles (Warrior, Trader, Shaman). Order doesn’t matter, so all 256 ways to play collapse onto a small triangle: pure play reaches a corner, two-color play lands on an edge, and balanced play ends near the center.
- **For:** A programmer joining the game team, who has been handed a 256-row spreadsheet of outcomes and can’t hold it in their head.
- **Question:** How do a player’s choices across the game decide which archetype their species becomes?
- **Facts** (from the talk’s slides “Calculating Space Game Archetypes”, dated March 10, 2008, and the final archetype chart; the counts are recomputed):
  - A species passes four stages before space: cell, creature, tribe and civilization. Finishing a stage earns one token, and a new species starts with four white tokens.
  - Each stage’s token is red (played aggressively: carnivore, strong, aggressive, military), blue (played neutrally: omnivore, versatile, adaptive, economic) or green (played kindly: herbivore, social, friendly, religious). A stage that is skipped leaves its white token, which counts for nothing.
  - So there are 4 × 4 × 4 × 4 = 256 ways to play. Only the colors count, not which stage earned them, so the 256 reduce to 35 different sets of four tokens.
  - One color alone, or three of one color plus any fourth: that color’s pure archetype, red Warrior, blue Trader, green Shaman. More tokens of the color don’t change the archetype; they add super powers.
  - Two colors: a mixed archetype, red and blue Scientist, red and green Zealot, blue and green Diplomat.
  - All three colors, one of them twice: red twice Knight, blue twice Bard, green twice Ecologist.
  - One of each color plus a white: the last color earned decides, which is the one case where order matters. (The earlier spreadsheet sent this case to Wanderer instead.) Four whites: Wanderer.
  - Out of the 256 ways: 23 each reach Warrior, Trader and Shaman; 42 each Scientist, Zealot and Diplomat; 12 each Knight, Bard and Ecologist; 25 Wanderer, by the spreadsheet’s rule.
  - Treat each token as a step: red up, blue down-left, green down-right, white no step. One of each color cancels out, so the 35 sets land on 31 points of a triangle four steps on a side. Three of those points hold two archetypes each (Warrior and Knight, for example), because one red plus a red-blue-green set lands where one red alone does.
- **Shape:** A mix of a few poles: every outcome is a blend of three components, so it lives in a triangle.
- **Must show:**
  - the three pure archetypes as the three extremes;
  - one stage as one step toward a pole, and a whole game as a path of four steps;
  - the mixed archetypes between the poles they mix;
  - that different orders of the same tokens reach the same place.
- **Traps:**
  - a tree or ring of 256 leaves, which puts unrelated outcomes side by side (the talk’s own first try);
  - the 256-row table, or a 4 × 4 × 4 × 4 grid;
  - a box per archetype holding its rule as a sentence;
  - animating a path when the question is about where paths end;
  - stating the 35 sets or 31 points without drawing them.

## The message for the agent under test

Give it only this, word for word. It holds the rules and the question, not the idea, the shape or the traps.

> I’m new on a game team, and I’m trying to understand our archetype system. A species goes through four stages: cell, creature, tribe and civilization. Each stage you finish gives you one token: red if you played it aggressively, blue if you played it neutrally, green if you played it kindly. A stage you skip stays white, and white counts for nothing. At the end, your four tokens decide your archetype, and only the colors count, not which stage gave them. One color alone, or three of one color plus anything, makes you that color’s pure archetype: red is Warrior, blue is Trader, green is Shaman. Two colors make a mix: red and blue is Scientist, red and green is Zealot, blue and green is Diplomat. All three colors with one doubled: double red is Knight, double blue is Bard, double green is Ecologist. One of each color plus a white: the last color you earned decides. Four whites is Wanderer. The programmers have a 256-row spreadsheet of every combination and nobody can hold it in their head. Can you explain visually how a player’s choices decide their archetype?

## The disguised version

The message above names Spore’s stages and archetypes, so a model that knows the game, or the talk, could recall the triangle instead of finding it. The disguised version keeps the rules, the 256 ways, the 35 sets and the 31 points identical, and renames every term at random (Python’s `random.Random(20261106)` drawing from neutral word lists):

| Spore | Disguised |
|---|---|
| Stages: cell, creature, tribe, civilization | Shifts: dawn, noon, dusk, night |
| Red, blue, green token (aggressive, neutral, kind) | Slate, amber, jade token (forging, weaving, brewing) |
| White token (skipped) | Copper token (shift skipped) |
| Warrior, Trader, Shaman | Torthorn, Morward, Veywick |
| Scientist, Zealot, Diplomat | Ulmwick, Dalford, Iverstead |
| Knight, Bard, Ecologist | Fenmoor, Selstead, Kelwick |
| Wanderer | Halwick |

Give the agent under test only this:

> I’m new on a game team, and I’m trying to understand our title system. A character works four shifts: dawn, noon, dusk and night. Each shift worked earns one token: slate for forging, amber for weaving, jade for brewing. A shift skipped stays copper, and copper counts for nothing. At the end, your four tokens decide your title, and only the kinds count, not which shift gave them. One kind alone, or three of one kind plus anything, gives that kind’s pure title: slate is Torthorn, amber is Morward, jade is Veywick. Two kinds make a mix: slate and amber is Ulmwick, slate and jade is Dalford, amber and jade is Iverstead. All three kinds with one doubled: double slate is Fenmoor, double amber is Selstead, double jade is Kelwick. One of each kind plus a copper: the last token you earned decides. Four coppers is Halwick. The programmers have a 256-row spreadsheet of every combination and nobody can hold it in their head. Can you explain visually how a player’s choices decide their title?

The scenarios that use it have names, a project and a conversation title that say nothing about Spore or the skill (`trial-c1`, `trial-c2`), because the agent sees its working folder, which is named after the scenario, and the project’s name.
