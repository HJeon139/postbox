# Code block

![Code block](../../screenshots/code-block.png)

**Where:** Agent replies with code.

## Why it exists

Code you can copy, with its filename and language.

## Expected functionality

- Syntax-highlighted code with filename, language and a Copy button.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Press Copy in “Catalog tour”.

**Pass if:** The code is on the clipboard and a confirmation shows.
