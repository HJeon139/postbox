# Background work that outlives a turn

When an agent starts work in the background, such as a gate, a CI watch or a server, its turn should end once the model is done. The work keeps running, the room can see it, and the agent that started it is woken when it ends.

The approach is native harness first, and Postbox adds no tool for it. Agents start background work their harness’s own way: `run_in_background`, `&`, `nohup` or `tmux`. Postbox keeps what the harness reports, and finds the rest by a marker that each harness process inherits. Each harness gets this only after a live check passes for it, and keeps today’s behavior until then. Where a step can’t be shown safe, it falls back to today’s behavior too, never to losing work.

Status: proposed for [#1614](https://github.com/HJeon139/postbox/issues/1614), not built. It replaces an earlier draft, which added four Postbox tools and a launcher. On [#1615](https://github.com/HJeon139/postbox/pull/1615), the owner directed that Postbox integrate with each harness instead, because agents use their harness’s own way and fumble Postbox-specific mechanisms. It also covers the attribution [#1606](https://github.com/HJeon139/postbox/issues/1606) asks for, for the processes a session leaves behind.

## The problem

**Claude Code waits for its background tasks.** When an agent starts a command with `run_in_background` and finishes its answer, the CLI stays alive until the task ends. Then it reports the task in a turn of its own. Postbox ends a turn only when the CLI’s process closes (`server/adapters/claude-code.mjs`, `child.on('close', settle)`). Until then `Running.busy()` stays true, `Delivery.ready()` (`server/delivery.mjs`) returns false, and every message to the agent waits.
- **Measured with the real CLI in #1614:** a reply with no background command exited at 7.6 s. The same reply after `sleep 90` with `run_in_background` exited at 98.2 s.
- **In the room on 21 and 22 November 2026:** agents’ messages waited 26 to 167 minutes behind their own background gates and CI watches.

**Codex, Kiro and Antigravity fail the other way.** Each runs in its own process group, and Stop and the turn’s end kill that group (#126). So background work dies with the turn. On a host, the daemon owns that group (`server/remote/host/daemon-kill.mjs`).

**On any harness, some work escapes.** A foreground call can start `cmd &`, `nohup cmd &` or `setsid cmd` and then let its shell exit. The child is reparented to init. It’s no longer under the CLI, so `shellGroups` (`server/adapters/process-group.mjs`) doesn’t find it, Stop doesn’t reach it, and nothing tracks it. That’s #1606’s orphan.

## What `main` already has

- **Recognizing a task.** Claude Code’s `run_in_background` tasks are recognized from the stream (`server/adapters/claude-stream.mjs`). Each is recorded as a job with its task id, command and output file (`server/harness-events.mjs`, `startJob`). At the turn’s result, `on_turn_end` lists the jobs still running (`tools.waiting`). The Agent SDK reports the same tasks.
- **Keeping a job.** Send now stops the CLI with `jobs: 'keep'` (`server/message-queue.mjs`, `stopForSendNow`). `stopTurn`’s `keep` (`server/adapters/process-group.mjs`) finds each kept job by its command among the CLI’s tool shells (`shellGroups`), and keeps it. It’s lenient: it takes the first match, and if any job goes unmatched, it keeps every unmatched shell.
- **Seeing a job end.** A 5-second poll of the kept jobs’ process groups sees each one end (`server/kept-jobs.mjs`, #129, #164). Each kept job has its own Stop.
- **On a host:**
  - the daemon records a turn’s tool shells’ groups, and matches them by their members’ start times (`daemon-kill.mjs`, `liveGroups`, `sameProcess`);
  - it doesn’t parse the harness’s stream, and stores `out.jsonl` for Postbox to read (`server/remote/host/cleanup.mjs`);
  - `stopTurn` on a host returns `stopRemote(child)`, which ignores `keep`, so Send now keeps no jobs on a host today.

This design extends those pieces. It adds no tool, no listener and no permission surface. Every command is still one the agent ran through its harness’s own shell tool, judged in the persona’s mode.

## The design

```mermaid
sequenceDiagram
  participant H as The harness (Claude Code CLI)
  participant S as Postbox
  participant J as The background work
  H->>J: run_in_background (the harness reports the task)
  H-->>S: the turn’s result; on_turn_end lists the tasks still running
  S->>S: binds each task to one group, and scans for marked processes
  alt every listed task binds
    S->>H: stops the CLI and its other shells, keeping the bound groups
    Note over S: The turn ends: Running.busy() is false, messages arrive
  else any task doesn’t bind
    Note over S,H: the turn waits, as on main today
  end
  loop every 5 s
    S->>J: still alive? (members with their recorded start times)
  end
  J-->>S: gone
  S->>S: commits the job’s end and one wake, together
  S->>H: a new turn: “Your background job … ended”
```

### 1. Binding a harness task to its group

Postbox binds a task the harness reported to exactly one live process group. Every rule below must hold in one `ps` snapshot, taken at the `result` while the CLI that Postbox holds as its own child is still alive:
- **The task is live, by the harness’s own account.** The owning turn’s stream reported it starting, with `task_started` and its tool call id, and hasn’t reported it ending. There’s no `task_notification` for it yet.
- **Exactly one shell matches.** Among the CLI’s tool shells (`shellGroups`: children of the CLI that lead their own groups), exactly one runs the task’s command.
- **That shell started inside the task’s own call.** Its leader’s start time (`lstart`, to the second) falls between two moments: when Postbox read the call’s `tool_use` line, and when it read that call’s result. Each end is widened by one second. These are Postbox’s receive times, because the stream carries no timestamp of its own.
- **No other call could account for it.** No other tool call in the turn ran the same command, foreground or background, including calls by the turn’s subagents. The stream records every call’s input, so this reads the harness’s own record. It covers a task that exited before its notification arrived, while another call’s shell runs the same command.

A bound job is recorded with its task id, its group id, each member’s pid and start time, the owning session and the owning turn.

### 2. When the turn ends early, and when it waits

**Claude Code and the Agent SDK.** At the `result`, Postbox ends the CLI early only when every task `on_turn_end` lists binds by section 1. Then it stops the CLI through a strict mode of `stopTurn`:
- **Kept:** each bound job’s whole group survives.
- **Stopped:** the CLI and every other tool-shell group under it. They get SIGINT, then SIGKILL after `GRACE_MS`, as today.

If any listed task doesn’t bind, Postbox leaves the turn as `main` does: it waits for the CLI to report its tasks and exit. So the strict rules can cost latency, never work: an unbound task is never killed. The same wait applies while the model still works:
- before the `result`;
- while a subagent runs;
- while a permission card waits;
- while a Monitor runs, until its live check passes.

The strict mode is apart from Send now’s lenient keep, which stays as it is, because the person chose to keep those jobs. Whether Send now should also be strict is a question for its own issue.

**Codex, Kiro and Antigravity: signal by pid, not by group.** Postbox chooses how it signals (`stopPgid`, `signalPgid`). At such a turn’s end, it can signal the harness and the processes it still parents by pid, and leave the marked background work that section 3 binds. It turns this on for a harness only once that harness’s live check passes. Until then the group kill stays, so nothing changes for it.

**Identity is checked again before every pid signal.** Once Postbox signals by pid, a reused pid is the risk, so no pid is signaled on an old reading. Before each signal, Postbox reads that pid’s start time in a fresh `ps` read and signals only if it still matches the one recorded. That covers the first SIGINT, the SIGKILL `GRACE_MS` later, a Stop, and the restart sweep. A pid whose start time changed, or that is gone, is skipped and recorded as ended. The window left is between that read and the signal itself: milliseconds, and not zero.

**Group signals get the same check.** On `main` only the host daemon matches a group by its members’ start times. The local `liveGroups` (`server/kept-jobs.mjs`) checks only the leader’s command line. `listProcesses` reads no start time, and `stopTurn`’s group signals don’t go through `liveGroups` at all. `stopPgid` sends its delayed SIGKILL with no second check. So the local `ps` read gains `lstart`. Before each group signal, including the delayed SIGKILL, the kept-job poll and the strict stop check that a member still has its recorded start time, as the daemon does.

### 3. The marker, for work the harness doesn’t report

Postbox starts every harness process with two variables in its environment: `POSTBOX_SESSION=<session id>` and `POSTBOX_TURN=<turn id>`. Neither is a secret, and the turn’s MCP token never goes into the environment (#54, #126). Every descendant inherits both at exec, including after `setsid`, `nohup` or reparenting to init, which the process group can’t follow.

**What binds.** A tool shell that backgrounds a command exits within milliseconds, and its child is reparented to init. The integrator measured this with a fake harness running `/bin/sh -c 'node -e … & echo $!'`. The shell lived 4.7 to 4.9 ms. Its child’s parent became pid 1, and its group stayed whichever group the shell had: its own, or the harness’s. A 5-second poll almost never sees such a shell, so ancestry recorded by polling can’t bind it. At a turn’s end, a process is bound as this turn’s background work in two cases:
- **(a) It’s in the harness’s own process group.** Membership in that group is ancestry: only the harness and its descendants are in it. Such a process binds when it isn’t the harness and its start time falls inside the turn, with or without a readable marker. On macOS that covers #1614’s own `sleep 90 &`, whose `/bin/sleep` hides its environment.
- **(b) It’s outside that group,** after `setsid` or as the orphan of a tool shell that led its own group. It binds when all of these hold:
  - its marker names this session and this turn;
  - its start time falls inside the turn;
  - its parent is init or the subreaper.

**Why the marker is enough in case (b).** A forged marker can only come from a process of the person’s own user, and that process can already signal any of these processes. So a forger gains at most a spurious wake for the agent the marker names. A Claude Code task that section 1 handled is left to section 1.

**Nothing leaks that `main` reaps.** At a turn’s end that uses pid signals, any process still in the harness’s group that didn’t bind gets that harness’s group signal, as today. That includes a marked process inside the turn that fails a rule above. A process outside the group that carries the marker but doesn’t bind stays informational: shown in the room with its pid as last seen, with no wake, no signal and no Stop. That’s the same as `main`, which never reached it either.

**The poll’s cost.** On `main`, `pollKept` runs `ps` only while a kept job exists (`server/kept-jobs.mjs`). This design adds the marker scan at each turn’s end, and at each 5-second tick only while kept jobs exist. One scan per tick serves every turn and job. The implementation PR measures the scan, `ps -Eww -ax`, whose output is larger than today’s read, against `main`’s poll, and holds it to a budget stated there.

**What the scan reads.** The scan keeps only the two marker variables from its output, and nothing else of any process’s environment. Raw scan output is never logged or stored.
- **On macOS:** `ps -Eww -ax -o pid=,ppid=,pgid=,lstart=,command=`.
- **On Linux:** `/proc/<pid>/environ`.

It’s one more read beside `listProcesses`, with the same 2 s timeout and 16 MB cap.

**What it costs, measured.** On macOS (Darwin 25.6), `ps -E` prints no environment for Apple platform binaries. Four processes were started with `POSTBOX_SESSION=probe123`, then read with `ps -E -p <pid> -o command=`:

| Process | Marker visible |
|---|---|
| `/bin/sleep 30` | no |
| `nohup /bin/sh -c '/bin/sleep 31'` (exec’d to `sleep`) | no |
| Xcode’s `python3`, after `os.setsid()` | yes |
| `node -e …` | yes |

So on macOS a job is found through any member that isn’t a platform binary, such as node, npm, gh, cargo or python. Its group is then found by its group id. A job made only of `/bin/sh` and `/bin/sleep`, like #1614’s own `sleep 90`, isn’t found by the marker. That’s why the marker is combined with the ancestry recorded while the harness is alive, and why a Claude Code task is bound by section 1, not by the marker.

Other ways the marker is lost or misused:
- **A fresh environment.** A process that execs with a new environment drops the marker and isn’t tracked. That includes `env -i`, `sudo`, `launchctl`, `systemd-run`, and work handed to `docker` or `ssh`. Changing the environment after exec changes nothing, because the scan reads the kernel’s exec-time copy.
- **Linux, not verified here.** `/proc/<pid>/environ` is readable for the same user’s dumpable processes, but not for setuid processes or under `hidepid`. Each host’s live check confirms it.
- **A process that drops or forges its marker.** One that drops it isn’t tracked, as a `nohup` process isn’t today. One that copies another session’s marker was never seen under that session’s harness, so it’s never bound or signaled. At most it shows as marked but not bound.

### 4. Wake on exit

When a kept job ends, the agent that started it gets one wake, sent the way a scheduled wake is (`server/scheduled-wakes.mjs`, `rt.delivery.send`):

> Your background job “npm run check” ended after 4 min 12 s. Its last 50 lines: …

- **The end.** A job has ended when no member of its group still has its recorded start time.
- **The exit status** comes only from the harness, in a `task_notification` the CLI sent before it was ended. Otherwise the wake says “exit status unknown”.
- **The output tail** comes from the harness’s own output file, and only within the harness’s own authority:
  - **The folder:** derived from what Postbox knows, not from text. It’s Claude Code’s per-session task folder, found from the user id, the working folder and the `init` event’s session id. The path in the tool result’s text (`BACKGROUND_FILE` in `claude-stream.mjs`) is only a hint, accepted inside that folder alone. A structured `output_file` in a `task_notification`, if one arrives, must name the same file.
  - **Off the turn end’s path:** the keep decision comes first and never waits on the file. Postbox verifies the file afterward, asynchronously, within a 1 s budget.
  - **Opening:** with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, so a FIFO or device can’t block the open. Postbox keeps the descriptor.
  - **Checks:** `fstat` must show a regular file, owned by the person’s user, with one link. `realpath.native` of the path must lie inside the folder and have the descriptor’s device and inode. Postbox records that device and inode.
  - **Reading:** at the end, through the descriptor only, at most the last 8 KB and 50 lines.
  - **What the checks guard:** an agent could swap its task’s output file for a link to a file that its persona’s Read rules deny while its shell rules allow it. The checks keep Postbox from reading that file for it.
- **After a restart,** the descriptor is gone. Postbox reopens the path with the same flags and checks, and reads it only if the device and inode match what it recorded. Otherwise the wake says the output isn’t available.
- **A redirect.** With `cmd > log 2>&1`, the harness’s file is empty. Postbox doesn’t read the redirect target: the wake names it, unread (“Its output went to `log`”), and the agent reads it with its own tools at no extra cost. So Postbox never reads a path the agent chose, which the agent’s Read rules might deny.
- **`tmux` is welcome, not required.** A `tmux new -d` session’s processes are found by the marker. The wake names the session, unread (“Its output is in tmux session `build`”), and the agent can run `tmux capture-pane` itself. tmux isn’t the mechanism, because it isn’t on every host and agents would have to choose it.
- **Quoted as data:** an @-mention in the tail wakes no one.
- **Once.** The job’s end and its wake are committed together. A restart or a host reconnect that finds the job already ended wakes no one again.
- **Quiet in the room.**
  - The wake goes only to the agent that started the job. It counts as no hop and raises no “needs you”.
  - Each job stays visible in the room until it ends, then shows its end. That isn’t an alarm: the agent it wakes acts on it (AGENTS.md, “No unactionable alarms”).
  - The person can Stop any bound job. An agent can stop only its own session’s.

### 5. Remote hosts use the same code

A host gets the turn-end path only with both of these. Until then it keeps today’s behavior.
- **A stream reader in `shared/`.** Section 1’s binding needs `task_started`, `task_notification`, each tool call with its input and result, and the `result`. On `main`, the parser is `server/adapters/claude-stream.mjs`, and `hostFiles` (`server/remote/install-bundle.mjs`) ships only `shared/` and `server/remote/host/`. A small reader of just those events moves to `shared/`, and both the server and the daemon load it. Then the daemon can bind a result that arrives while the laptop sleeps.
- **A stop that keeps.** `daemon-kill.mjs` gains the strict keep: it stops the runner and its other shells, and keeps the bound groups. For Codex, Kiro and Antigravity on a host, it also gains section 2’s pid signal, gated by the same live check. On `main` it signals the runner’s group. The binding rule, the marker scan, the poll and the job record live in one `shared/` module.

The daemon keeps polling, and keeps each job’s record, tail and status in its own data folder, never in the workspace. It does this while the laptop sleeps or the link is down. On reconnect, a job that ended while the two were apart wakes its agent once, from the stored record, in one commit. Jobs still running reappear as they are.

The protocol messages:
- **`jobs.kept`:** daemon to laptop, the jobs a turn’s end kept.
- **`jobs.list`:** daemon to laptop on reconnect, every job’s record.
- **`jobs.ended`:** daemon to laptop, live.
- **`jobs.stop`:** laptop to daemon.
- **`jobs.ack`:** laptop to daemon, once the end and its wake are committed, so the daemon can drop the record.

A daemon from before this change doesn’t list `jobs` in its welcome. With one, the laptop keeps today’s behavior. That follows the welcome-field pattern that `claudeChecks` uses (`server/adapters/claude-code-remote.mjs`, and remote-hosts.md, “Postbox and the daemon”). While a host is disconnected, its jobs show in the room as unknown, last seen at a time, never as an alarm.

```mermaid
sequenceDiagram
  participant L as Laptop (Postbox)
  participant D as Host daemon
  participant J as Job on the host
  L->>D: run turn
  D->>J: the harness starts a background task
  D->>D: at the result, binds J (shared reader), stops the runner keeping J
  D-->>L: turn result, then jobs.kept
  Note over L,D: the laptop sleeps, and the link drops
  J-->>D: ends (seen by the daemon’s poll)
  D->>D: stores J’s end and tail in its data folder
  Note over L,D: the laptop reconnects
  D-->>L: welcome (lists jobs), then jobs.list
  L->>L: commits J’s end and one wake, together
  L->>D: jobs.ack
  D->>D: drops J’s record
```

### 6. Restart

After a Postbox or daemon restart, a kept job is adopted again only if a member of its recorded group still has its recorded start time, so a long run survives an upgrade. A job that doesn’t match is recorded as ended, with “Postbox restarted while it ran: exit status unknown”, and wakes its agent once. Nothing is adopted that wasn’t bound before the restart.

## The guide

`TURN_ENDS` (`server/adapters/guide.mjs`) is Codex-only on `main`.
- **A harness with this design on** gets one line: “Background work is fine: you’re woken when it ends.” For Codex it replaces `TURN_ENDS`; for the others it’s the only addition.
- **A harness without it** keeps what its guide says today. Codex keeps `TURN_ENDS`, and Kiro and Antigravity get nothing new.
- **`intent.md`:** the “Attention and wakes” row adds a kept job’s end to what wakes an agent.

## Live checks, per harness, to record here

Each check is a local run of up to 3 turns, so the cost is bounded: up to 3 turns per harness, with real agents, as AGENTS.md asks of any run that costs real usage. A harness gets this design only once its check passes. The check goes through the normal turn path and shows three things:
- the background job survives the turn’s end;
- an ordinary foreground child the turn left behind is stopped;
- a room message reaches the owner while the job still runs, and the job’s end wakes it once.

What each check answers:
- **Claude Code:** with `-p` stream-json, does ending the CLI after the `result` keep every task, Monitor included? Does each task’s output file go on filling?
- **Codex:** does the app-server end a turn while a backgrounded child runs, and what does it do to that child? Does the marker reach its tool shells?
- **Kiro and Antigravity:** what happens to `&` and `nohup` at the turn’s end? Does the marker reach their tool shells?
- **Each Linux host:** is `/proc/<pid>/environ` readable for the agent’s processes?

## How it’s tested

- **The room outcome, through the normal turn path,** with recorded Claude Code streams. #1614’s recorded native stream, where the message waits, is the baseline.
  - A turn whose tasks all bind ends at its `result`.
  - A room message reaches the agent while the task runs.
  - The task’s end wakes the agent exactly once, including with a restart between seeing the end and queuing the wake.
- **`tests/process/`, with real processes:**
  - **Binding:** at the result, the bound job’s group survives, and the CLI and a foreground shell stop.
  - **Nothing binds, so nothing is lost:** two calls ran the same command, so nothing binds. The CLI isn’t ended, and both shells live.
  - **The late-notification case:** the task has exited, no `task_notification` has come, and another call’s shell runs the same command. Nothing binds, and the turn waits.
  - **A shell from before its call** doesn’t bind.
  - **The marker:**
    - it survives `nohup` and `setsid` on a non-platform binary, and the scan finds it;
    - `sh -c 'cmd &'`, with the shell in the harness’s group: `cmd` binds by group membership and wakes the agent;
    - `sh -c 'cmd &'`, with the shell leading its own group: `cmd`, reparented to init, binds by its marker and wakes the agent;
    - a process in the harness’s group that doesn’t bind is still stopped at the turn’s end;
    - a marked process outside the group that doesn’t bind isn’t signaled, and its exit queues no wake;
    - one with another session’s marker isn’t bound.
  - **Codex, Kiro and Antigravity by pid:** the harness and its children stop, and a bound marked process survives.
  - **A reused pid is skipped:** a pid whose start time changes between the first SIGINT and the delayed SIGKILL, or before a Stop, isn’t signaled.
  - **The output file:**
    - swapping the path for a link after binding, or replacing the file, changes nothing read;
    - a file outside the folder, a link, or a file with a second link gives no tail;
    - a FIFO doesn’t delay the turn end;
    - after a restart, a matching device and inode keep the tail.
- **Unit tests:**
  - the early-end decision for each end event;
  - the wake naming a redirect or a tmux session, unread;
  - the bounded, quoted tail;
  - no hop and no “needs you”;
  - Stop on another session’s job refused to agents;
  - only the marker variables kept from a scan.
- **The host:** a fake daemon, with the shared reader, through a disconnect, an exit while away and a reconnect. A second reconnect wakes no one, and an old daemon’s welcome keeps today’s behavior.
- **A browser spec** for the job items and their Stop, run plain and with `POSTBOX_STREAM_LAG=300`.

## When to revisit

- If live input is proven for a harness (designs/508/delivery-routes.md, “Model turns and a live backend execution (A′)”), its CLI could stay alive and take messages between turns. Ending it at the `result` would then no longer be needed there.
- If unbound tasks often keep a turn waiting, measure which rule fails them before loosening any.
