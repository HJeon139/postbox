# Attached sessions: resume and mirror

Part of [the architecture](../architecture.md).

**Decision.** A Claude Code session started in a terminal can join Postbox as an agent:
- **Writing to it:** Postbox resumes that session in its own folder.
- **Watching it:** Postbox follows its transcript in `~/.claude/projects/` and mirrors turns typed in the terminal, marked “from terminal”.
- **No duplicates:** lines written while a Postbox turn runs are that turn, already in the thread, so they’re skipped, and the tail jumps to the end when the turn finishes.

**What it rests on.** The transcript is the only shared record, and it records who started each turn (`turnOrigin`: human or sdk). Reading it needs no cooperation from the terminal.

**Revisit when** two writers become a problem in practice. Postbox can’t tell that a terminal turn is still running, so it relies on you to let it finish.
