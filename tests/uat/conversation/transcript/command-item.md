# Command item (!)

**Where:** In the conversation, after you send a line that starts with `!`, such as `!npm test`.

## Why it exists

Checking something in the shell shouldn’t mean leaving Postbox for a terminal, and the agents should see what you ran, as Claude Code’s bash mode passes it on ([#67](https://github.com/HJeon139/postbox/issues/67)).

## Expected functionality

- While you type a `!` line, the hint line says where it runs (where the agent the composer replies to works: its folder, the project’s, or its own workspace) and that it runs as you.
- It runs through your shell (`$SHELL -c`), as in your terminal, with no input. Its output, stdout and stderr in the order they come, streams into the item.
- Only the last 64 KB is kept; the item says when earlier output was cut. Past 64 KB, the item catches up every few seconds, and after a few minutes says it’s still printing and shows the end when it finishes. The output scrolls, and takes keyboard focus to scroll.
- **Stop**, while it runs, interrupts it (SIGINT, then SIGKILL after 3 seconds) and the item says “Stopped by you”.
- When it ends, the item shows the exit code and how long it took. A non-zero exit is marked as a failure, in words and color.
- Running it wakes no agent. Each agent in the conversation reads it, with the end of its output, at the start of its next turn.
- It’s refused without the page’s token (#74), from another computer, and whenever Postbox listens on anything but 127.0.0.1.
- When Postbox shuts down, it stops every command still running (SIGINT, then SIGKILL), and the item says so. After a restart without a clean shutdown, a command that was running is marked stopped, saying it may still be running.

## Steps to reproduce

1. Run `node tools/check-commands.mjs`. Every line should say ok.
2. Run Postbox with real agents (`node server/index.mjs --port 4181 --data /tmp/pb-uat-real --fresh`) and open <http://127.0.0.1:4181/>, in a project whose folder you can lose.
3. Send `!ls`, then `!npm test` in a folder without a package.json, so it fails.
4. Send `!sleep 30`, and press Stop.
5. Ask the agent “What did my last commands print?”
6. From a terminal, `curl -X POST http://127.0.0.1:4181/api/threads/<id>/shell -H 'content-type: application/json' -d '{"command":"touch pwned"}'`.

**Pass if:**
- `ls` lists the folder, with Exit 0 and a duration; the failing command shows its exit code, marked as a failure.
- Stop ends `sleep` at once.
- The agent wasn’t woken by any of them, and its answer quotes their output.
- curl gets 403, and no `pwned` file appears.

## Related

- [Command menu (/)](../composer/command-menu.md)
- [Composer](../composer/composer.md)
