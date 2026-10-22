# Review block

![Review block](../../screenshots/review-block.png)

**Where:** Line-by-line review of a spec, code or an app.

## Why it exists

Feedback on long documents needs to be anchored to lines, batched, and followed by a visible revision.

## Expected functionality

- Each line can take a comment; the add-comment button is always visible.
- Markdown renders by block, the way it does in a reply: a table is a table, a list keeps its numbering and nesting, a code fence is code and a quote is quoted. Each table row, list item and code line takes its own comment; a table’s delimiter row and a fence’s markers don’t show.
- In a diff, an added or removed table row, list item or code line stays in place inside its block, marked added or removed.
- Comments are drafted, then submitted with a verdict (comment, approve, request changes).
- A revision shows as a diff against the previous version; resolved threads collapse.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. In “Corpus schema spec”, comment on two lines, request changes, then read the revised diff.

**Pass if:** The revision arrives with a diff and your threads marked resolved or open.
