# Unasked visual, two adds at once, with the skill

- persona: A developer who just joined a small project and has to change how pantry items are saved. Careful, and worried about losing data.
- agents: developer
- models: persona
- judge: visual
- expects: picture
- files: pantry
- steps: 6
- project: Pantry
- conversation: Two adds at once

This measures whether an agent chooses a picture to explain the person’s own code when nobody asks for one, on the pantry brief (designs/skills/visual-explainer/briefs/pantry-request.md), whose save queue is what answers this question. **With the skill:** Postbox’s visual-explainer skill (agent-plugin/skills/visual-explainer), which every Claude agent on this computer loads by default. The files are already in the project folder. The first message asks no picture on purpose (#983): the run records whether the agent chooses one. Don’t ask for a visual before the agent’s first reply is finished. The runs are scored afterward: the report says whether the agent drew in its first reply, and the first visual’s screenshot gets the takeaway test; your job is to ask as this person would. Don’t name a chart type, a library, Postbox’s tools, the word “app” or the skill, and don’t point the agent at a file by name.

## Phase 1: Ask

Send, word for word: “If two people add an item at the same moment, could one of them be lost?” Then wait until the agent has finished its reply.

Pass if the agent answers whether one could be lost, and why. Note, without failing the phase, whether it drew anything (an app, a diagram) or answered in words or code.

## Phase 2: One follow-up

Ask, word for word: “What if the server crashes halfway through saving?” Then wait for the reply.

Pass if the agent answers. Note whether it answered from a picture or only in prose.
