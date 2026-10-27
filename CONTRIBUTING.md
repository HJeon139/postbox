# Contributing

Postbox is planned in GitHub issues. An issue’s assignee, labels and links say whether it’s free to pick up. Read them before you start, so two people don’t build the same thing.

## Pick up work that’s ready

An issue is **ready** when it’s open, has a priority label, and none of these apply:

| Signal | What it means |
|---|---|
| An assignee | Someone has claimed it, and is working on it in an open pull request or a running session. Its comments name the PR. |
| `needs decision` label | It waits on the maintainer’s decision. Its comments say which decision. |
| Blocked by an open issue (GitHub’s “Blocked by” in the sidebar) | It builds on another issue that hasn’t landed. |

The `in progress` label is retired as a claim. The assignee says who has the issue, which the label never did. Issues that already carry the label stay claimed until they close, so the searches below skip them too. Don’t add the label to new claims.

Saved searches:
- [Ready to pick up, P1 first](https://github.com/HJeon139/postbox/issues?q=is%3Aissue+is%3Aopen+no%3Aassignee+-is%3Ablocked+-label%3A%22in+progress%22+-label%3A%22needs+decision%22+sort%3Acreated-asc+label%3AP1%2CP2) uses `is:open no:assignee -is:blocked -label:"in progress" -label:"needs decision" label:P1,P2`.
- [Unassigned](https://github.com/HJeon139/postbox/issues?q=is%3Aissue+is%3Aopen+no%3Aassignee) uses `is:open no:assignee`.
- [Mine](https://github.com/HJeon139/postbox/issues?q=is%3Aissue+is%3Aopen+assignee%3A%40me) uses `is:open assignee:@me`.
- [Assigned, with no pull request yet](https://github.com/HJeon139/postbox/issues?q=is%3Aissue+is%3Aopen+assignee%3A*+-linked%3Apr) uses `is:open assignee:* -linked:pr`. These are claims that have gone quiet, or work not started.
- [Waiting on a decision](https://github.com/HJeon139/postbox/issues?q=is%3Aissue+is%3Aopen+label%3A%22needs+decision%22)
- [Blocked](https://github.com/HJeon139/postbox/issues?q=is%3Aissue+is%3Aopen+is%3Ablocked)

## Claim it, then build it

1. **Claim it, in two places.** Assign the issue to yourself and comment that you’re taking it. Do both before you write code. The assignee is what the searches read, and the comment says what you plan to do.
   ```bash
   gh issue edit <n> --add-assignee @me
   gh issue comment <n> --body "Taking this."
   ```
   If you can’t assign yourself (GitHub lets only people with triage access or above assign others, and outside contributors often don’t have it), comment that you’re taking it and ask the maintainer to assign you. Until then the issue isn’t claimed, so wait for the assignment before you build. One assignee per issue; a second person comments first and the maintainer decides.
2. **Name it in the pull request.** Put `Fixes #n` in the PR body, not only in a commit, so GitHub links the two.
3. **Follow the project's rules.** The same rules apply to everyone, people and agent sessions alike:
   - `AGENTS.md`, and the `AGENTS.md` in each folder you change: the rules, short, with the design section each comes from. Claude Code, Codex, Kiro and Antigravity read them on their own (#315).
   - `designs/engineering-practices.md`
   - `designs/developing.md`
   - `designs/prompts/README.md`: ports, `--data`, length limits, the gate, scope and hand-off
4. **When it merges,** the issue closes and the claim ends with it. If you stop before then, unassign yourself (`gh issue edit <n> --remove-assignee @me`) and comment where you got to. The maintainer may unassign a stale claim, one with no pull request and no word for a while, and says so in a comment.

The wave plan, with which issues are grouped into which session and in what order, is in `designs/prompts/README.md`. The maintainer's triage comments are on #64.
