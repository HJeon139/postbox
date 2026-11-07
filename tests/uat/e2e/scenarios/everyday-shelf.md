# Everyday visual, book shelf, with the skill

- persona: Someone with a personal collection of books (downloads, library scans, their own ebooks, some in translation) who is about to index them for search, and can’t yet say which ones to include. Thoughtful, and not a programmer.
- agents: researcher
- models: persona
- judge: visual
- seed: visual-skill
- files: book-shelf
- steps: 6
- project: Library
- conversation: What’s on the shelf

This measures how an agent explains the person’s own data with a picture, one of the everyday briefs (designs/skills/visual-explainer/briefs/book-shelf.md). **With the skill:** the draft visual-explainer skill (designs/skills/visual-explainer) sits in the project as a Claude Code project skill (`- seed: visual-skill`). The files are already in the project folder. The runs are scored afterward, with the takeaway test on the first visual’s screenshot; your job is to ask as this person would. Don’t name a chart type, a library, Postbox’s tools, the word “app” or the skill, and don’t point the agent at a file by name.

## Phase 1: Ask

Send, word for word: “I’m about to index these books for search, and I can’t yet say which ones are worth it. The list is in this folder. What have I got?” Then wait until the agent has finished and its visual is on screen.

Pass if a visual is on screen. Note, without failing the phase, whether it’s an app, a Markdown diagram or a table, and what it shows first.

## Phase 2: One follow-up

Ask, word for word: “Which copies would you index, and what would I lose by leaving the rest out?” Then wait for the reply.

Pass if the agent answers by pointing at the visual or changing it. Note whether it answered from the picture or only in prose.
