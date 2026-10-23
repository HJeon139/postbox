# Review block

![Review block](../../screenshots/review-block.png)

**Where:** Line-by-line review of a spec, code or an app.

## Why it exists

Feedback on long documents needs to be anchored to lines, batched, and followed by a visible revision.

## Expected functionality

- Each line is its own comment target: click it, or Tab to it and press Enter, to open its comment box. A dim mark in the gutter (the line number and a dot, filled once the line has comments) shows every line takes one, without hovering. Screen readers hear “Comment on line 12”.
- Closing a comment box (Add draft comment, Cancel or Escape) puts focus back on its line.
- Markdown renders by block, the way it does in a reply: a table is a table, a list keeps its numbering and nesting, a code fence is code and a quote is quoted. Each table row, list item and code line takes its own comment; a table’s delimiter row and a fence’s markers don’t show.
- In a diff, an added or removed table row, list item or code line stays in place inside its block, marked added or removed.
- Comments are drafted, then submitted with a verdict (comment, approve, request changes).
- A revision shows as a diff against the previous version; resolved threads collapse.
- If the agent changes the draft while you’re answering, your submit is refused, your comments are kept, and you see what changed: see [A block that changed while you were answering](changed-while-answering.md).

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. In “Corpus schema spec”, comment on two lines (one by clicking the line, one with Tab and Enter), request changes, then read the revised diff.

**Pass if:** The revision arrives with a diff and your threads marked resolved or open.
