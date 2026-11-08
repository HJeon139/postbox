# Unasked visual, subscriptions to cancel, with the skill

- persona: Someone who pays for a lot of subscriptions, keeps a list of them with how often each got used, and wants to cut back. Writes short messages, and wants a decision, not a lecture.
- agents: researcher
- models: persona
- judge: visual
- expects: picture
- files: subscriptions
- steps: 6
- project: Home
- conversation: Cutting back

This measures whether an agent chooses a picture for a decision about the person’s own data when nobody asks for one, on the subscriptions brief (designs/skills/visual-explainer/briefs/subscriptions.md). **With the skill:** Postbox’s visual-explainer skill (agent-plugin/skills/visual-explainer), which every Claude agent on this computer loads by default. The files are already in the project folder. The first message asks no picture on purpose (#983): the run records whether the agent chooses one. Don’t ask for a visual before the agent’s first reply is finished. The runs are scored afterward: the report says whether the agent drew in its first reply, and the first visual’s screenshot gets the takeaway test; your job is to ask as this person would. Don’t name a chart type, a library, Postbox’s tools, the word “app” or the skill, and don’t point the agent at a file by name.

## Phase 1: Ask

Send, word for word: “Which of my subscriptions should I cancel? My list, with how much I’ve used each one, is in this folder.” Then wait until the agent has finished its reply.

Pass if the agent answers which to cancel. Note, without failing the phase, whether it drew anything (an app, a diagram) or answered in words or a table.

## Phase 2: One follow-up

Ask, word for word: “And which ones am I right to keep, even though they cost a lot?” Then wait for the reply.

Pass if the agent answers. Note whether it answered from a picture or only in prose.
