# Words control, starting the project, baseline

- persona: A developer who just cloned a small project and wants to run it. In a hurry, writes short messages, and wants the command.
- agents: developer
- models: persona
- expects: words
- files: pantry
- steps: 6
- project: Pantry
- conversation: Running it
- skills: off

This is a control (#983, #206): a question about the person’s own code that a command answers best, so a picture is the miss. **Baseline:** without Postbox’s skills (`- skills: off`), the same files and words, to compare with the run that has it. The files are already in the project folder. The runs are scored afterward: the report says whether the agent drew anything; your job is to ask as this person would. Don’t name a chart type, a library, Postbox’s tools, the word “app” or the skill, and don’t point the agent at a file by name.

## Phase 1: Ask

Send, word for word: “How do I start this project?” Then wait until the agent has finished its reply.

Pass if the agent gives the command (`npm start`, or `node src/server.mjs`). Note, without failing the phase, whether it drew anything (an app, a diagram) or answered in words.

## Phase 2: One follow-up

Ask, word for word: “Which port does it listen on?” Then wait for the reply.

Pass if the agent answers from the code (8080). Note whether it drew anything.
