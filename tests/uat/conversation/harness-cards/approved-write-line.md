# Approved write line

**Where:** In the conversation, under the block you approved, when the agent’s next turn opens or comments on what that block named.

## Why it exists

You approve a push or a PR in a confirm or a review block, and the agent’s `gh pr create` then asked you again on a permission card, for the same call. In one room that happened at least seven times in three days, and Always allow didn’t help: each PR had its own title ([#296](https://github.com/HJeon139/postbox/issues/296)). Now the write you approved runs, and this line says so, so nothing outside Postbox happens without you seeing why.

## Expected functionality

- A turn your answer started (Confirm on a confirm block, or Approve on a review) may run these `gh` writes without a card:
  - `gh pr create` and `gh issue create`, when the block names the title in full (at least 12 characters);
  - `gh pr comment`, `gh pr edit`, `gh issue comment` and `gh issue edit`, on a number or link the block names (#537), or on a PR or issue this conversation created (its Work lists the `gh pr create` and its link).
- Postbox decides, in code. Everything else still gets the card: merging, closing, reviews, releases, labels, reviewers, assignees and milestones; a `--repo` the block doesn’t name; a branch instead of a number; a command with anything else in it (`; rm`, a `$( )` other than a quoted here-document for the body); a turn your typed message started; a confirm you declined.
- One approval lets five writes through. The sixth gets the card.
- Each write leaves a line: “Ran gh pr create for @now without asking: you confirmed ‘Push 2d7c9a65’”, in the block’s own words (its confirm button, or the review’s title).
- **Stop these writes** ends that approval. The line says “· Stopped”, a line in your voice says “Stopped: @now’s next write outside Postbox asks you first”, and its next write gets the card.
- The persona’s Permissions panel turns it off: “Writes you approved in a block run without asking again”, on by default.
- The button works by keyboard, and the line reads the same without color.

## Steps to reproduce

1. Run `npx playwright test approved-writes` (`tests/browser/approved-writes.spec.mjs`). It confirms a block, sees the write run with its line and no card, presses Stop, sees the next write get a card, and turns the setting off in the panel. It should pass.
2. Run Postbox with real agents (`node server/index.mjs --port 4181 --data /tmp/pb-uat-real --fresh`, with Claude Code installed and signed in), in a project whose folder is a clone of a repository you can open test PRs on. Ask an agent: “Make a one-line change on a new branch, then show me a confirm block that names the PR’s exact title. Once I confirm, push and open it.”
3. Confirm the block.

**Pass if:**
- The PR opens with no permission card, and the line under the block names `gh pr create` and the button you pressed.
- Asking the same agent, in the same turn, to add a label (`gh pr edit <n> --add-label …`) gets a card.

## Related

- [Permission card](permission-card.md)
- [Permissions panel](../../shell/permissions-panel.md)
