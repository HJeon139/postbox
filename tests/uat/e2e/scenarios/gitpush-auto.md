# Git push in Auto: pushes and a PR you asked for, with no card

- persona: A developer who ships small changes all day and wants an agent to commit and push each one without asking every time. Writes short messages, names the branch, and checks the remote, not the agent’s word, for what landed.
- agents: developer
- permission_modes: developer=auto
- project: Push loop
- conversation: Small changes, pushed in Auto
- seed: git-remote

@developer runs on Claude Code in Auto. A push or a PR you asked for in your own message should run without a card (#296, #961), and Postbox makes a push itself, to the project’s repository, which the runner sets to the remote. Before Postbox starts, the runner makes the project folder a git repository, and makes a bare repository in the run’s own folder as its `origin` (`- seed: git-remote`, #305, #296). Every git in this run is refused any remote but a local folder, and the gh first on the agent’s PATH is a fake that records what it was asked and creates nothing. That keeps an agent’s ordinary pushes and PRs from leaving this computer; it isn’t containment against an agent setting out to escape it, and in Auto no card stands between such an agent and a command that undoes the guard. The runner removes the remote when the run ends. Always name the branch `work` when you ask for a push: Postbox makes a push you asked for itself, and it never pushes to the remote’s default branch unless you name it. Ask for each push as its own Bash call, exactly `git push origin work`, with nothing chained to it by `&&`, `;` or a loop: Claude Code checks each part of a chained command on its own, so a card for a chain offers no Always allow (#238), and one call that pushes in a loop is one card and one line in the Work pane for many pushes. The same goes for commits: ask for each change to be made with Edit, then `git add notes.md` and `git commit -m "…"` as two calls of their own, so their cards can offer Always allow too. Every change is one new line at the end of `notes.md`, such as “Change 7.”: no code and no tests, since this run is about the pushes. Watch for a card that comes back for a push you already allowed, a push the agent says it made that the remote doesn’t have, and the conversation getting slower as the pushes add up.


## Phase 1: Ten pushes and a PR, with no card

- triggers: auto-writes-no-card
- steps: 10

Ask @developer for ten small changes, each its own commit and a push of `work` to origin after it, and then to open a pull request from `work` with `gh pr create`, with a title and a one-line body. Say plainly that you want all of it done without asking you: you’re asking for these pushes and the PR. None of these calls should come to a card. If any does, report it as a finding, with what the card says and how many pushes had run before it, then allow it once and go on.

## Phase 2: Ten more pushes in Auto, twenty in all

- triggers: pushes-at-scale
- steps: 16

Ask @developer for ten more small changes, each its own commit and a push of `work` to origin after it, as its own `git push origin work` call, never a loop. Say plainly again that you want them all pushed without asking you. Postbox lets at most five calls you asked for run in one turn without a card (`REQUESTED_MAX`), so if a card comes back after the fifth push in a turn, report it as a finding with the push count, allow it once, and go on. When it’s done, the remote should have twenty or more pushes, and the Work pane one push line for each.
