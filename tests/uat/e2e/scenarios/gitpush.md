# Git push: many commits and pushes, what asks you, and what the work ledger grows by

- persona: A developer who ships small changes all day and wants an agent to commit and push each one without asking every time. Writes short messages, names the branch, and checks the remote, not the agent’s word, for what landed.
- agents: developer
- permission_modes: developer=ask
- project: Push loop
- conversation: Small changes, pushed
- seed: git-remote

@developer runs on Claude Code. Before Postbox starts, the runner makes the project folder a git repository, and makes a bare repository in the run’s own folder as its `origin` (`- seed: git-remote`, #305, #296). Every git in this run can reach only local folders, and gh here is a fake that records what it was asked and creates nothing, so nothing leaves this computer. The runner removes the remote when the run ends. Always name the branch `work` when you ask for a push: Postbox makes a push you asked for itself, and it never pushes to the remote’s default branch unless you name it. Watch for a card that comes back for a push you already allowed, a push the agent says it made that the remote doesn’t have, and the conversation getting slower as the pushes add up.

## Phase 1: The first push, allowed once

- triggers: push-card-landed
- steps: 6

First, open the project’s Settings and set its repository to the remote’s folder, the path this run gives you. Then ask @developer to make a tiny Python module with one function and a test, on a new branch `work`, commit it, and push the branch `work` to origin. @developer is in Ask me, so the push should come to a permission card that names the remote. Read it, then press Allow once. The push should land: ask @developer to show `git ls-remote origin work`, and compare it with its last commit.

## Phase 2: Always allow, then no more cards

- triggers: always-allow-no-card
- steps: 8

Ask @developer for one small change, a commit, and a push of `work` to origin. When its card comes, press Always allow. Then ask for three more small changes, each its own commit, each pushed to `work` on origin right after it’s made. None of those three pushes should come to a card. If one does, report it as a finding, with the card’s rule and the push it asked about, then press Allow once and go on.

## Phase 3: Twenty pushes in a row

- triggers: pushes-at-scale
- steps: 10

Ask @developer for twenty small changes, one at a time, each its own commit, and a push of `work` to origin after each one: twenty commits and twenty pushes. They can be as small as one line each, such as a new constant or a docstring. While it works, open the Work pane: each push should show there. When it’s done, check the conversation and the Work pane still respond at once, and report anything that got slower.

## Phase 4: In Auto, pushes and a PR with no card

- triggers: auto-writes-no-card
- steps: 10

Open @developer’s quick panel from the Agents section and set its permissions to Auto. Then ask it for ten small changes, each its own commit and a push of `work` to origin after it, and then to open a pull request from `work` with `gh pr create`, with a title and a one-line body. Say plainly that you want all of it done without asking you: you’re asking for these pushes and the PR. None of these calls should come to a card. If any does, report it as a finding, with what the card says and how many pushes had run before it, then allow it once and go on.
