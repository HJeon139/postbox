# Git push: many commits and pushes, what asks you, and what the work ledger grows by

- persona: A developer who ships small changes all day and wants an agent to commit and push each one without asking every time. Writes short messages, names the branch, and checks the remote, not the agent’s word, for what landed.
- agents: developer
- permission_modes: developer=acceptEdits
- project: Push loop
- conversation: Small changes, pushed
- seed: git-remote

@developer runs on Claude Code in Accept edits, so its edits run without a card and its commands and pushes ask. Before Postbox starts, the runner makes the project folder a git repository, and makes a bare repository in the run’s own folder as its `origin` (`- seed: git-remote`, #305, #296). Every git in this run is refused any remote but a local folder, and the gh first on the agent’s PATH is a fake that records what it was asked and creates nothing. That keeps an agent’s ordinary pushes and PRs from leaving this computer; it isn’t containment against an agent setting out to escape it. The runner removes the remote when the run ends. Always name the branch `work` when you ask for a push: Postbox makes a push you asked for itself, and it never pushes to the remote’s default branch unless you name it. Ask for each push as its own Bash call, exactly `git push origin work`, with nothing chained to it by `&&`, `;` or a loop: Claude Code checks each part of a chained command on its own, so a card for a chain offers no Always allow (#238), and one call that pushes in a loop is one card and one line in the Work pane for many pushes. The same goes for commits: ask for each change to be made with Edit, then `git add notes.md` and `git commit -m "…"` as two calls of their own, so their cards can offer Always allow too. Every change is one new line at the end of `notes.md`, such as “Change 7.”: no code and no tests, since this run is about the pushes. The Auto case is its own scenario, `gitpush-auto`, which runs once #961 has merged. Watch for a card that comes back for a push you already allowed, a push the agent says it made that the remote doesn’t have, and the conversation getting slower as the pushes add up.

## Phase 1: The first push, allowed once

- triggers: push-card-landed
- steps: 6

Ask @developer to create `notes.md` with one line, on a new branch `work`, commit it, and push the branch `work` to origin. A push is a write outside Postbox, so even in Accept edits it should come to a permission card that names the remote. Read it, then press Allow once. The push should land: ask @developer to show `git ls-remote origin work`, and compare it with its last commit.

## Phase 2: Always allow, then no more cards

- triggers: always-allow-no-card
- steps: 8

Ask @developer for one small change, a commit, and a push of `work` to origin. When the cards for its `git add`, its `git commit` and its push come, press Always allow on each. Then ask for three more small changes, each its own commit, each pushed to `work` on origin right after it’s made. None of those three pushes should come to a card. If one does, report it as a finding, with the card’s rule and the push it asked about, then press Allow once and go on.

## Phase 3: Twenty pushes in a row

- triggers: pushes-at-scale
- steps: 16

Ask @developer for twenty small changes, one at a time, each its own commit, and a push of `work` to origin after each one, as its own `git push origin work` call, never a loop: twenty commits and twenty pushes. With Always allow from phase 2, none of them should come to a card. While it works, open the Work pane: each push should show there. When it’s done, check the conversation and the Work pane still respond at once, and report anything that got slower.
