# Math

![Math](../../screenshots/math.png)

**Where:** Inside replies ($…$ and $$…$$).

## Why it exists

Cost models and formulas are part of the explainers.

## Expected functionality

- Inline and display math render with KaTeX; prices like “$5” are not treated as math.
- Wide formulas scroll sideways and can be scrolled by keyboard.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Open “ReAct, step by step” and check the cost formula.

**Pass if:** The formula renders crisply.
