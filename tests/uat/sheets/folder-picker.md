# Project folder picker

![Project folder picker](../screenshots/folder-picker.png)

**Where:** + › From the project folder.

## Why it exists

Attach project files by reference without uploading.

## Expected functionality

- Browses the project’s root folder only; Up, Open, Attach.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Attach a book file and send it.

**Pass if:** The file is attached as a reference.
