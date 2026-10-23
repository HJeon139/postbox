# Work view

![The Work view](../screenshots/work-view.png)

![A turn’s line, under its activity](../screenshots/work-chip.png)

**Where:** The **Work** tab beside a conversation’s title in the top bar (`#/t/<id>/work`), the conversation’s ⋯ › Work, and the line under an agent’s activity in the transcript (“4 files +15 −3 · 4 commands (1 failed) · $0.31”), which opens one turn’s work.

## Why it exists

The person directs agents that edit code, run commands, commit, push and file issues. Without this view they learn the state of the work only by asking an agent to recount it, and then have to trust the recounting ([#132](https://github.com/HJeon139/postbox/issues/132)). The Work view lists everything the agents’ work touched and what it cost, from the tool calls themselves, never from what an agent said.

## Expected functionality

- **Scope:** every session in the conversation, its side and topic threads included. In a room, **All agents** or one agent.
- **Summary:** the files that are uncommitted, committed but not pushed, and pushed (and not in git, when any are), each with its file count and lines added and deleted. Then the effort: turns, wall time, tool calls, tokens and spend, and what it produced (“→ 4 files +15 −3”, with the lines written along the way when more were written than kept). Turns that tried something and left nothing lasting are counted, with a link to them. Changes to review are counted.
- **Files:** each file an agent’s Edit, Write or NotebookEdit changed, with:
  - its state from git (asked when the view opens and after each turn, with read-only commands);
  - lines added and deleted, counted from the diff against the file before the agents’ first change. A file edited and put back counts as nothing. A binary file shows its sizes before and after.
  - **Outside the project** for a file outside the project’s and the agent’s folders, and **Git can’t give it back** for a file that existed before and git doesn’t track. Both are flagged with a red edge, sorted first.
  - opened: its full path, the turns that changed it with their time and spend, each change with a link to its turn, the diff, and **Restore…** (or **Remove…** for a file an agent created).
- **Restore:** a confirm says what’s written back and what’s lost. It refuses when the file changed since the agents’ last change. The conversation gets a line in your voice (“Restored refs.bib to how it was before @researcher changed it”), which the agents read on their next turn.
- **Version control:** branches made, commits (hash, message, branch, files and lines from git, pushed or not) and pushes (branch, remote, refs).
- **Outside Postbox:** issues, pull requests and comments written with `gh` or a connector’s write tool, each with its link.
- **Commands:** each command exactly as it ran, with its state in words and a glyph (Exit 0, Exit 2, Refused, Stopped, Running in the background, Didn’t report how it ended), its duration and who ran it (a subagent by name). Opened: the whole command, its description and all its output. A background command shows its output file’s contents once it ends, or says it was still running when the turn ended.
- **Effort:** a table by agent (turns, time, tool calls, tokens, spend, lines written, lines kept). Kept lines count toward the agent that changed a file last, so the rows add up to the total. Spend shows for Claude Code and Agent SDK turns, and “—” for the mock. Then **Left nothing lasting**, each turn with what it tried.
- **One turn** (from the transcript’s line): that turn’s changes, commands, commits and spend, with **Show the whole conversation**.
- It updates live as a turn works. Everything opens and closes by keyboard; the diff, the output and the table scroll on their own, and take focus to scroll. It fits a 375 px window without scrolling sideways.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Open “Citation fixes” once @researcher has answered “Fix the citation script” and “Try a faster parser”. Check the line under each reply.
3. Choose **Work** in the top bar. Open `refs.bib`, then the background command and the failed one.
4. Choose **Restore…** on `refs.bib`, then **Restore**. Go back to the conversation.
5. Choose the second reply’s line.
6. With a real agent in a git repository you can lose, ask it to edit a file, run a failing command, commit on a new branch and push to a local bare remote (`git init --bare /tmp/remote.git`). Open Work, and compare its files and lines with `git diff --stat` and `git show --stat`.

**Pass if:**
- The first reply’s line reads “4 files +15 −3 · 4 commands (1 failed) · 1 outside Postbox”; the second’s “1 command (1 failed)”.
- `notes.md` is outside the project; `refs.bib` and `cite.mjs` can’t be given back by git; the diff of `refs.bib` shows `yeer` replaced by `year`.
- After Restore, `refs.bib` has `yeer` again on disk, reads **Put back**, and the conversation has the line in your voice.
- The second turn is listed under **Left nothing lasting**, and its view shows only the benchmark command.
- With the real agent: the counts match git’s, the commit is listed with its branch and **Pushed**, and the branch is listed as made.

## Related

- [Activity line](transcript/activity-line.md)
- [Command item (!)](transcript/command-item.md)
- [Conversation menu](../shell/top-bar/conversation-menu.md)
