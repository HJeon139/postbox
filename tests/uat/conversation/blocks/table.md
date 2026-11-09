# Table block

![Table block](../../screenshots/table-block.png)

**Where:** Agent replies with tabular data.

## Why it exists

Data you can sort and act on per row.

## Expected functionality

- A number column groups digits (12,345), but a column named for a year or an id shows its whole numbers as written: 2023, not “2,023” (#836).
- Sortable columns (number columns sort numerically), a row action button per row. The row action is an inline action, its label underlined, so it reads as a button and not as one more cell (#182).
- Large tables scroll inside the block. A table wider than its block fades the edge that has more columns past it: the right edge at first, both part way, the left at the end. A table that fits shows no fade (#1000).
- The scroll region is a tab stop named for the table (“Works, scrolls”), so the arrow keys scroll it.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. In “Catalog tour”, sort by a number column and use a row action.
3. Ask an agent for a table of eight or more columns, at 1280 px and at 375 px. Scroll it sideways to the end and back, by trackpad and by Tab then the arrow keys.

**Pass if:** Sorting is correct and the row action sends { rowId }. The wide table’s right edge fades at rest, the fade follows the scroll to the left edge at the end, no column is hidden at either end, and a table that fits shows no fade.
