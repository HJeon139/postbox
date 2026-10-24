# Contributing

Postbox is planned in GitHub issues. An issue's labels and links say whether it's free to pick up. Read them before you start, so two people don't build the same thing.

## Pick up work that's ready

An issue is **ready** when it's open, has a priority label, and none of these apply:

| Signal | What it means |
|---|---|
| `in progress` label | Someone is working on it now, in an open pull request or a running session. Its comments name the PR. |
| `needs decision` label | It waits on the maintainer's decision. Its comments say which decision. |
| Blocked by an open issue (GitHub's "Blocked by" in the sidebar) | It builds on another issue that hasn't landed. |

Saved searches:
- [Ready to pick up, P1 first](https://github.com/HJeon139/postbox/issues?q=is%3Aissue+is%3Aopen+-is%3Ablocked+-label%3A%22in+progress%22+-label%3A%22needs+decision%22+sort%3Acreated-asc+label%3AP1%2CP2) uses `is:open -is:blocked -label:"in progress" -label:"needs decision" label:P1,P2`.
- [In progress](https://github.com/HJeon139/postbox/issues?q=is%3Aissue+is%3Aopen+label%3A%22in+progress%22)
- [Waiting on a decision](https://github.com/HJeon139/postbox/issues?q=is%3Aissue+is%3Aopen+label%3A%22needs+decision%22)
- [Blocked](https://github.com/HJeon139/postbox/issues?q=is%3Aissue+is%3Aopen+is%3Ablocked)

## Claim it, then build it

1. **Claim it.** Comment on the issue that you're taking it, and add the `in progress` label, or ask the maintainer to. Do this before you write code.
2. **Name it in the pull request.** Put `Fixes #n` in the PR body, not only in a commit, so GitHub links the two.
3. **Follow the project's rules.** The same rules apply to everyone, people and agent sessions alike:
   - `designs/engineering-practices.md`
   - `designs/developing.md`
   - `designs/prompts/README.md`: ports, `--data`, length limits, the gate, scope and hand-off
4. **When it merges,** the issue closes and the `in progress` label comes off with it. If you stop before then, remove the label and say where you got to.

The wave plan, with which issues are grouped into which session and in what order, is in `designs/prompts/README.md`. The maintainer's triage comments are on #64.
