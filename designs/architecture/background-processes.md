# Background work that outlives a turn

When an agent starts work in the background, such as a gate, a CI watch or a server, its turn should end when the model is done. The work keeps running, the room can see it, and the agent that started it is woken when it ends.

The approach is native harness first. Postbox adds no tool. It keeps the background jobs a harness itself starts and reports, such as Claude Code’s `run_in_background` tasks, and wakes the agent when one ends. A harness that doesn’t report its background work keeps today’s behavior until its own mechanism is verified and added here.

Status: proposed for [#1614](https://github.com/HJeon139/postbox/issues/1614), not built yet. It replaces an earlier draft that added four Postbox tools and a launcher. On [#1615](https://github.com/HJeon139/postbox/pull/1615), the owner directed that Postbox integrate with each harness instead, because agents use their harness’s own way and fumble Postbox-specific mechanisms. It covers the attribution [#1606](https://github.com/HJeon139/postbox/issues/1606) asks for, for the jobs it keeps.

## The problem

**Claude Code waits for its background tasks.** When an agent starts a command with `run_in_background` and finishes its answer, the CLI stays alive until the task ends, then reports it in a turn of its own. Postbox ends a turn only when the CLI’s process closes (`server/adapters/claude-code.mjs`, `child.on('close', settle)`). So `Running.busy()` stays true, `Delivery.ready()` (`server/delivery.mjs`) returns false, and every message to the agent waits.
- **Measured in #1614 with the real CLI:** a reply with no background command exited at 7.6 s. The same reply after `sleep 90` with `run_in_background` exited at 98.2 s.
- **Seen in the room on 21 and 22 November 2026:** agents’ messages waited 26 to 167 minutes behind their own background gates and CI watches.

**The other harnesses fail the other way.** Codex, Kiro and Antigravity each run in their own process group, which Stop and the turn’s end kill (#126). So their background work dies with the turn. On a host, the daemon owns that group (`server/remote/host/daemon-kill.mjs`).

## What `main` already has

- **Recognizing a job.** Claude Code’s `run_in_background` tasks are recognized from the stream (`server/adapters/claude-stream.mjs`) and recorded as jobs with the harness’s own metadata: its task id, its command and its output file (`server/harness-events.mjs`, `startJob`).
  - At the turn’s result, `on_turn_end` lists the jobs still running (`tools.waiting`).
  - The Agent SDK reports the same tasks.
- **Keeping a job.** Send now stops the CLI with `jobs: 'keep'` (`server/message-queue.mjs`, `stopForSendNow`). `stopTurn`’s `keep` (`server/adapters/process-group.mjs`) finds each kept job by its command among the CLI’s own tool shells (`shellGroups`, children of the CLI that lead their own groups). It signals the CLI and its other shells, and leaves those job groups alone.
- **Seeing a job end.** A 5-second poll of the kept jobs’ process groups sees each one end (`server/kept-jobs.mjs`, #129, #164). Each kept job has its own Stop.
- **On a host.** The daemon records a turn’s tool shells’ groups, and matches each group by its members’ start times, so a reused pid is never signaled (`daemon-kill.mjs`, `liveGroups`, `sameProcess`).

This design reuses those pieces. It adds no tool, no listener and no permission surface. Every command is still one the agent ran through its harness’s own shell tool, judged in the persona’s mode.

## The design

```mermaid
sequenceDiagram
  participant H as The harness (Claude Code CLI)
  participant S as Postbox
  participant J as The job's tool shell group
  H->>J: run_in_background (the harness reports the task: id, command, output file)
  H-->>S: the turn's result; on_turn_end lists the tasks still running
  S->>S: binds each task to its tool shell group (a child of the CLI, by command)
  S->>H: stops the CLI and its other shells, keeping the bound groups
  Note over S: The turn ends: Running.busy() is false, messages arrive
  loop every 5 s
    S->>J: still alive? (group members with their recorded start times)
  end
  J-->>S: gone
  S->>S: commits the job's end and one wake, together
  S->>H: a new turn: "Your background job … ended", with its output tail
```

### 1. Which jobs Postbox keeps: only tasks bound to one live group

A job is kept only when Postbox can bind the harness’s task to exactly one live process group, at the moment it ends the turn. Every one of these must hold, read from one `ps` snapshot taken while the CLI Postbox holds as its own child is still alive:
- **The task is live, by the harness’s own account.** The owning turn’s stream reported it starting, with `task_started` (its task id and tool call id), and hasn’t reported it ending: there’s no `task_notification` for it yet.
- **Exactly one shell matches.** Among the CLI’s tool shells (`shellGroups`: children of the CLI that lead their own groups), exactly one runs the task’s command.
- **That shell started inside the task’s own call.** Its leader’s start time (`lstart`, to the second) falls between its tool call’s start and that call’s result, each widened by one second for the clock’s resolution.

If none matches, more than one matches, or the match started outside its call, the task is ambiguous and nothing is kept for it. The same goes for a task that ended before the result, or a CLI that has already exited. An ambiguous task’s processes are stopped with the CLI, as every other foreground shell is. Postbox never keeps a group it couldn’t bind.

A bound job is recorded with its task id, its group id, each member’s pid and start time, the owning session and the owning turn.

**A strict path, apart from Send now’s.** `stopTurn`’s `keep` (`server/adapters/process-group.mjs`) is lenient for Send now. It takes the first shell running a command. If any job goes unmatched, it keeps every unmatched shell, because the person chose to keep the jobs, and a shell it couldn’t place might be one. The turn-end path is a separate, strict mode: it keeps only bound groups and stops every other shell. Send now keeps its current behavior. Whether Send now should also go strict is a separate question, for its own issue.

### 2. When the turn ends, and what survives it

**Claude Code and the Agent SDK.** When the turn’s `result` has arrived and the only thing keeping the CLI alive is the jobs `on_turn_end` lists, Postbox ends the CLI through the existing stop path with `jobs: 'keep'`. The turn ends there.
- **What survives:** each bound job’s whole process group.
- **What stops:** the CLI, and every other tool shell group under it, including any foreground child a call left behind. `stopTurn` sends them SIGINT, then SIGKILL after `GRACE_MS`, as it does today.
- **When it doesn’t apply:** while the model still works. That means before the `result`, while a subagent runs, and while a permission card waits.
- **The Monitor tool:** it is kept only once its live check below passes. Until then, a turn with a Monitor running waits as today.

**Codex, Kiro and Antigravity.** They don’t report background work in their streams today, and their turn’s process group holds the agent’s background children together with the harness. A group signal reaches every member, so Postbox can’t keep one member of that group. These harnesses keep today’s behavior: the turn’s end kills the group. Each one gets this design only once two things hold:
- the harness reports its background work, or Postbox can bind it to the turn as in section 1;
- the live checks below pass for it.

The guide tells their agents what happens now: background work stops when the turn ends.

### 3. Wake on exit

When a kept job ends, the agent that started it gets one wake, sent the way a scheduled wake is (`server/scheduled-wakes.mjs`, `rt.delivery.send`):

> Your background job “npm run check” ended after 4 min 12 s. Its last 50 lines: …

- **An end means the whole group is gone.** A job has ended when no member of its group still has its recorded start time.
- **Exit status.** It comes only from the harness. A task notification the CLI sent before Postbox ended it carries one. Otherwise the wake says “exit status unknown”. Postbox reads no exit file a command wrote.
- **Output tail.** It comes only from a file the harness owns, and its identity is checked when Postbox opens it and holds:
  - **The folder comes from harness metadata, not from text.** Claude Code writes task output under its own per-session folder in the temp folder. Postbox derives that folder from what it knows: the person’s user id, the turn’s working folder and the session id from the CLI’s `init` event. It resolves the folder with `realpath.native` once, when the session starts.
  - **The path in the tool result’s text is only a hint.** The stream parser takes `outputFile` from the tool result’s words (`BACKGROUND_FILE` in `claude-stream.mjs`), so it’s never trusted on its own. The only path accepted is one inside the derived folder. A `task_notification`’s structured `output_file` must name that same file.
  - **Opened once, at binding, and held.** While the CLI is still alive, Postbox opens the file with `O_RDONLY | O_NOFOLLOW` and keeps the descriptor. It then checks the descriptor itself: `fstat` must show a regular file, owned by the person’s user, with one link. Then it resolves the path with `realpath.native`, and the result must lie inside the derived folder. The resolved path’s `lstat` must have the same device and inode as the descriptor. Any check that fails means no tail for that job.
  - **Read through the descriptor only.** At the job’s end, Postbox reads at most the last 8 KB and 50 lines through the held descriptor, never by path again, so a path that changed after binding changes nothing it reads.
  - **Unavailable otherwise.** After a restart the descriptor is gone, so the wake says “output not available: Postbox restarted while it ran”. The same goes for a job whose file failed a check, or a harness with no such folder. Postbox never reads a redirect on the command line, an exit file, or a multiplexer pane (`tmux capture-pane`).
  - **Quoted as data.** The tail is quoted, so an @-mention in it wakes no one.
- **Once.** The job’s end and its wake are committed together. A restart, or a host reconnect, that finds the job already ended wakes no one again.
- **Quiet in the room.** The wake reaches only the agent that started the job. It counts as no hop and raises no “needs you”. Each job stays visible in the room with its Stop until it ends, and then shows that it ended. That isn’t an alarm: the agent it wakes acts on it (AGENTS.md, “No unactionable alarms”).
- **Stop.** The person can Stop any job. An agent can stop only its own session’s jobs (#1606).

### 4. Remote hosts use the same code

The binding rule, the keep decision, the poll and the job record live in one module under `shared/`. The server and the host daemon both load it. `shared/` modules already reach the host through `hostFiles` (`server/remote/install-bundle.mjs`).
- **On a host, the daemon does the work.** It binds and keeps the jobs from the runner’s stream and its tool shells, as in section 1, then ends the runner. It polls the jobs, and keeps each job’s record, output tail and status in its own data folder, never in the workspace. It keeps doing this while the laptop sleeps or the link is down.
- **On reconnect,** the laptop and the daemon reconcile. A job that ended while they were apart wakes its agent once, from the stored record, in one commit. Jobs still running reappear as they are.
- **Protocol messages:**
  - `jobs.kept`: daemon to laptop, the jobs a turn’s end kept.
  - `jobs.list`: daemon to laptop on reconnect, every job’s record.
  - `jobs.ended`: daemon to laptop, live.
  - `jobs.stop`: laptop to daemon.
  - `jobs.ack`: laptop to daemon, once the end and its wake are committed, so the daemon can drop the record.
- **Older daemons.** A daemon from before this change doesn’t list `jobs` in its welcome. With one, the laptop keeps today’s behavior, as #1583 does with `claudeChecks`.
- **While a host is disconnected,** its jobs show in the room as unknown, last seen at a time, never as an alarm.

```mermaid
sequenceDiagram
  participant L as Laptop (Postbox)
  participant D as Host daemon
  participant J as Job on the host
  L->>D: run turn
  D->>J: the harness starts a background task
  D->>D: at the result, binds J, ends the runner keeping J
  D-->>L: turn result, then jobs.kept
  Note over L,D: the laptop sleeps, and the link drops
  J-->>D: ends (seen by the daemon's poll)
  D->>D: stores J's end and tail in its data folder
  Note over L,D: the laptop reconnects
  D-->>L: welcome (lists jobs), then jobs.list
  L->>L: commits J's end and one wake, together
  L->>D: jobs.ack
  D->>D: drops J's record
```

### 5. Restart

After a Postbox or daemon restart, a kept job is adopted again only if a member of its recorded group still has its recorded start time. A long run then survives an upgrade. A job that doesn’t match is recorded as ended, with “Postbox restarted while it ran: exit status unknown”, and wakes its agent once. Nothing is adopted that wasn’t bound before the restart.

## The guide

- **Harnesses with this design on:** `TURN_ENDS` says to start long work with the harness’s own background option, and that the agent will be woken when it ends.
- **The others:** the guide keeps saying that background work stops when the turn ends.
- **`intent.md`:** its “Attention and wakes” row adds a kept job’s end to what wakes an agent.

## Live checks, per harness, to record here

Each check is a local run of up to 3 turns (contract §8). A harness gets this design only once its check passes, and the result is recorded here. The check runs through the normal turn path and shows three things:
- the background job survives the turn’s end;
- an ordinary foreground child the turn left behind is stopped;
- a room message reaches the owner while the job still runs, and the job’s end wakes it once.

What each harness’s check answers:
- **Claude Code:** with `-p` stream-json, does ending the CLI after the `result` keep every task, Monitor included? Does each task’s output file go on filling?
- **Codex:** does the app-server report a background child, and what does it do to that child at the turn’s end?
- **Kiro and Antigravity:** what happens to `&` and `nohup` at the turn’s end, and does either harness report them?

## How it’s tested

- **The room outcome, through the normal turn path,** with recorded Claude Code streams:
  - a turn that leaves a background task ends at its `result`;
  - a room message reaches the agent while the task runs;
  - the task’s end wakes the agent exactly once, including with a restart between seeing the end and queuing the wake.

  #1614’s recorded native stream, where the message waits, is the baseline.
- **`tests/process/`, with real processes:**
  - at the result, the bound job’s group survives, while the CLI and a foreground shell are stopped;
  - two shells running the same command bind neither, and both are stopped;
  - **The ambiguous match critic named:** the background task has ended, and a foreground shell runs the same command. Nothing is kept, and the foreground shell is stopped.
  - a task whose shell exits before binding is kept by no one;
  - a shell that started before its task’s call doesn’t bind;
  - **The output file’s identity:** swapping the path for a link after binding, or replacing the file, changes nothing that is read. A file outside the derived folder, a linked file, or one with a second link gives no tail.
  - a group whose members’ start times changed isn’t signaled or adopted.
- **Unit tests:**
  - the keep decision for each end event;
  - the output file’s ownership checks, and that a path outside the harness’s folder reads as unavailable;
  - the bounded, quoted tail;
  - no hop and no “needs you”;
  - Stop on another session’s job is refused to agents.
- **The host:** a fake daemon covers a disconnect, an exit while away, a reconnect, a second reconnect that wakes no one, and an old daemon’s welcome.
- **A browser spec** for the job items and their Stop, run plain and with `POSTBOX_STREAM_LAG=300`.

## When to revisit

- **Live input for a harness.** If A′ live input ([delivery-routes.md](../508/delivery-routes.md)) is proven for a harness, its CLI could stay alive and take messages between turns. Ending it at the `result` would no longer be needed there.
- **Unreported background work.** If agents on Codex, Kiro or Antigravity often lose background work at the turn’s end, measure how often first. Then find a native way to see that work before adding anything agents would have to choose.
