# Math

![Math](../../screenshots/math.png)

**Where:** Inside replies ($…$ and $$…$$).

## Why it exists

Cost models and formulas are part of the explainers.

## Expected functionality

- Inline and display math render with KaTeX; prices like “$5” are not treated as math.
- `$$…$$` on one line is display math, centered on its own line, with no stray dollar signs, the same as `$$` on lines of their own around a formula (#147). Inside a line of text it draws as display math too.
- LaTeX’s own delimiters draw too: `\(…\)` as inline math, and `\[…\]` as display math, on one line or with `\[` and `\]` on lines of their own (#137). Without its closing delimiter, `\[` is an escaped bracket and shows as `[`, as before; in code it shows as written.
- Wide formulas scroll sideways and can be scrolled by keyboard.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Open “ReAct, step by step” and check the cost formula.

**Pass if:** The formula renders crisply.
