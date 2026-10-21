# Attach a Claude Code session

**Where:** + › Attach a Claude Code session (only when Claude Code is installed).

## Why it exists

Work you started in a terminal can continue in Postbox, and what you type in the terminal is mirrored there.

## Expected functionality

- Lists recent Claude Code sessions with their folder, title and age; attached ones are marked.
- Attach creates an agent in that session’s folder with its recent history; Postbox resumes the same session when you write to it.
- Turns typed in the terminal appear marked “from terminal”.

## Steps to reproduce

1. Run Postbox with real agents (`node server/index.mjs --port 4181 --data /tmp/pb-uat-real --fresh`, with Claude Code installed and signed in) and open <http://127.0.0.1:4181/>.
2. Start `claude` in a scratch folder, send one message, quit.
3. In Postbox, + › Attach a Claude Code session, attach it, and send a message.
4. Run `claude --resume <id>` in the terminal and type a message.

**Pass if:** The history appears, Postbox’s reply continues the same session, and the terminal turn is mirrored.
