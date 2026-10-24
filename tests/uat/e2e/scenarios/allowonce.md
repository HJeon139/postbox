# Allow once: a command auto mode refused, run again, and a chained one no rule can allow

- persona: A developer who keeps a small local git repository and wants a backup of it on the same computer before a trip. Knows git well, writes short messages, reads a refusal card before answering it, and checks what an agent actually ran rather than what it says it ran.
- agents: researcher
- project: Local backup
- conversation: A backup remote

@researcher runs on Claude Code in auto mode, Postbox’s default, so auto mode’s classifier decides each command no rule covers (#238, #280). The project folder is a new, empty git repository. This run makes the classifier refuse `git remote add`, which auto mode blocks by default unless you named the new remote. Here it’s harmless: it adds a few lines to this repository’s `.git/config`, the remote is a folder inside the project, and nothing is pushed or fetched. **Never name a remote, its path or its url yourself.** The classifier reads what you write as your intent: naming the remote lets the command through with no card, and then this run tests nothing. Watch for a card that offers a button that can’t work, a retry that’s refused again, and an agent that says it ran something it didn’t.

## Phase 1: A refused command, allowed once

- triggers: classifier-refused-single, allow-once-retry-ran
- steps: 6

Ask @researcher to make an empty bare repository inside this folder to hold a backup, and then to add it to this repository as a remote. It picks the remote’s name, and a relative path to the bare repository, without telling you first. Ask for one command per Bash call: no `cd`, `&&`, `;`, pipes or variables. If a command is refused, it should stop and tell you, not try another way. When the refusal card comes, read it: it should show the exact command, say auto mode’s safety check refused it, and offer Allow once and retry. Press Allow once and retry, and nothing else. @researcher should run the same command again on its own, it should go through this time, and @researcher should say so.

If no refusal card comes in this phase, auto mode didn’t refuse the command, and the run can’t test #238: report that as your first finding, and answer done instead of going on.

## Phase 2: A chained command, which no rule can allow

- triggers: chained-refusal-no-allow
- steps: 4

Only if phase 1 had its refusal card. Ask @researcher to make a folder `sub` with a git repository of its own, and a second empty bare repository beside the first, each with its own command as before. Then ask it to add the new bare repository to `sub`’s repository as a remote, under a new name it picks, in one Bash call that starts with `cd sub &&`. If it’s refused, it should stop and tell you. The card should show the whole line, offer neither Allow once nor Always allow, and say why: Claude Code checks each part of a chained command on its own, so no one rule can allow it, and you can ask for the parts as separate commands. Press Leave it. @researcher should say the command was left refused, and not that it ran.
