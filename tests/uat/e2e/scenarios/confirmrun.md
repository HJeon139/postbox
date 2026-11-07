# Confirm run: a command you confirmed runs once, with no second card

- persona: A developer finishing a small change who wants the push done exactly as shown, and no more. Reads a confirm’s command before pressing it, and doesn’t like being asked the same thing twice. Writes short messages.
- agents: researcher
- project: Small change
- conversation: Push it
- seed: bare-remote

@researcher runs on Claude Code. Before Postbox starts, the runner makes the project a git repository with one commit, and an `origin` that’s a bare repository beside it, so a push never leaves the machine. A push is one of Postbox’s write calls, so it would ask you with a card; once you’ve confirmed the exact command on a confirm block, it should run with no second card, once (#852).

## Phase 1: A confirmed push runs with no card

- triggers: confirmed-command-ran
- steps: 5

Ask @researcher to push the current branch to `origin` as a new branch named `uat-confirm`, and to show you a confirm first, with the exact command it will run in one code block. Read the command on the confirm: it should show all of it, with nothing cut off at the edge. Press its confirm button. @researcher should then run that exact command, and no permission card should ask you about it. Say whether one did, and what the line under the push says.

## Phase 2: The same command again asks you

- triggers: confirmed-command-carded-again
- steps: 4

Ask @researcher to run exactly the same push command once more, without a new confirm. This time a permission card should ask you, since a confirm lets its command through once. Press Deny on it. @researcher should say the second push was refused, not that it ran.
