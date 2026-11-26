# Background work that outlives a turn

An agent whose background job is still running takes new messages right away. That’s the one outcome this design is for, on every backend and on remote hosts. A background job exists to free its agent for other work while it runs, so holding the agent busy until the job ends defeats it (designs/intent.md, “Function first”).

How: the turn ends when the model has replied, the job runs on, and its end wakes the agent that started it, once. Agents start background work their harness’s own way, with `run_in_background`, `&`, `nohup` or `tmux`, and Postbox adds no tool for it.

**Where it stands:** proposed for [#1614](https://github.com/HJeon139/postbox/issues/1614), and nothing here is built. On `main` an agent is held busy for its background work on four of the five backends, as “The problem” lists. **What’s next:** the owner’s decision on which step comes first for Claude Code on this computer, since live input has one passing run there (“Live checks before it’s built”). Then that step’s remaining checks, and the step.

**How this document got here:**
- An earlier draft added four Postbox tools and a launcher. On [#1615](https://github.com/HJeon139/postbox/pull/1615) the owner directed that Postbox integrate with each harness instead, because agents use their harness’s own way and fumble Postbox-specific mechanisms.
- The draft after that ended a turn early only when every task bound to exactly one process group under strict rules, and otherwise kept the wait. A review on 26 November 2026, summarized in [#1824](https://github.com/HJeon139/postbox/pull/1824), found that it left agents busy in the usual cases, such as a gate run in the foreground, fixed, then run again in the background. It also carried work that doesn’t stop the pile-up, which is now under “Later, not part of #1614”.
- The owner then stated the rule in the room, as #1824 quotes it: “the purpose of background jobs is to free up the agent to take new messages while the job is running in the background”, and holding the agent busy “must be removed”.
- The probe figures below that cite #1615’s review (456 ms and 3,004 ms, status 141, 4.7 to 4.9 ms) are in that pull request’s record. No fixture in the repo holds them, and they weren’t measured again for this rewrite.

## The problem

Postbox ends a turn only when the harness’s process closes (the `child.on('close', …)` handler in `server/adapters/claude-code.mjs`, `kiro-cli.mjs` and `antigravity-cli.mjs`). Until then `Running.busy()` stays true, `Delivery.ready()` (`server/delivery.mjs`) returns false, and every message to the agent waits in its inbox.

| Backend | What holds the agent after its reply, on `main` | The longest a message waits |
|---|---|---|
| Claude Code, this computer | The CLI stays alive until its background tasks end, then reports them in a turn of its own | The job’s whole run. Postbox sets no bound |
| Agent SDK | The same wait, inside the SDK | 2 h (`QUIET.backgroundMax` in `shared/limits.mjs`, passed by `server/adapters/sdk-background.mjs`, #1801). Then the SDK stops the work |
| Claude Code, on a host | The same wait, on the host | 2 h. Then the turn is stopped as hung (#847, `server/remote/turns-background.mjs`) |
| Kiro and Antigravity, this computer | An unredirected `cmd &` holds the CLI’s pipes, so `close` comes only when `cmd` ends | The job’s whole run. No bound |
| Kiro, on a host | Not verified. The host’s runner ends the harness at `exit`, not `close` (`server/remote/host/runner-turn.mjs`), so the held-`close` wait probably doesn’t exist there | Not verified. A quiet turn on a host with no running step is stopped as hung after the host’s `stallTimeout`, 15 minutes by default (`shared/remote-settings.mjs`, `server/remote/turns-resume.mjs`) |
| Codex | Nothing: the turn ends at the reply. But Postbox kills the turn’s process group then (`stopTurn` in `server/adapters/codex.mjs`), so background work dies, and the guide tells Codex agents to wait in the foreground (`TURN_ENDS` in `server/adapters/guide.mjs`) | The command’s whole run, as a foreground call |

The evidence:
- **Measured with the real CLI in #1614:** a Claude Code reply with no background command exited at 7.6 s. The same reply after `sleep 90` with `run_in_background` exited at 98.2 s.
- **In the room on 21 and 22 November 2026:** agents’ messages waited 26 to 167 minutes behind their own background gates and CI watches (#1614). The record doesn’t say how many of those watches were shell jobs and how many were Monitors or background subagents, which the first step doesn’t free. That split decides how much stop-and-keep frees, and isn’t known.
- **The Agent SDK’s limit** ([#1714](https://github.com/HJeon139/postbox/issues/1714)): after the last result the SDK waits for background work only up to `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, 10 minutes by default, and then stops that work. Two review rounds run as background subagents were lost that way on 22 November 2026. #1801 raised the limit to 2 h, which saved the work and lengthened the wait.
- **Kiro and Antigravity:** Node fires `close` only once the child’s stdio streams have closed. A probe of a fake harness that ran an unredirected `cmd &` measured `exit` at 456 ms and `close` at 3,004 ms (during #1615’s review). With `cmd > log 2>&1 &`, `close` follows `exit`, and `cmd` runs on with no wake.

## What `main` already has

The first step is built from these. What it adds to them is listed under “What the step adds”.
- **Recognizing a task.** Claude Code’s `run_in_background` calls, timed-out calls moved to the background, Monitors and background subagents are recognized from the stream (`server/adapters/claude-stream.mjs`). Each command is recorded as a job with its task id, command and output file (`server/harness-events.mjs`). At the turn’s result, `on_turn_end` lists the jobs and the subagents still running. The Agent SDK streams the same messages.
- **Keeping a job.** Send now stops the CLI with `jobs: 'keep'` (`stopForSendNow` in `server/message-queue.mjs`). `stopTurn`’s `keep` (`server/adapters/process-group.mjs`) sends the CLI SIGKILL at once, since its SIGINT handler would stop the jobs. It finds each job’s tool shell by its command, and keeps that shell’s process group. It’s lenient: a job it can’t tell apart is kept with every unmatched shell, so it’s never killed (#164). Once every job is found, it sends SIGKILL to every other tool shell, since in the middle of a turn those are foreground calls.
- **What Send now’s keep records.** It’s reachable only through `rt.stop(…, { jobs: 'keep' })`, which aborts the turn and records a stop (`server/turn-stop.mjs`, `server/stop-record.mjs`): the reply reads “Stopped”, its @-mentions wake no one (`server/mention-entries.mjs`), no `turn.ended` is raised, and the agent’s next turn is told the person stopped its last one (`server/job-records.mjs`). That’s right for a stop, and none of it is reused here.
- **What a resumed CLI says.** Claude Code, resumed, marks a background command it has no end for as stopped, and says so to the agent (#249). Postbox’s note at the next turn corrects it (`job-records.mjs`).
- **What the kill does to a job,** recorded with `ps` on Claude Code 2.1.296 for #126 (`process-group.mjs`’s opening comment): after SIGKILL to the CLI, its tool shells live on with init as their parent, and a background job keeps writing to its output file.
- **Seeing a job end.** A 5-second poll of the kept jobs’ process groups sees each one end (`server/kept-jobs.mjs`, #129, #164). The agent is told at its next turn, with the output file’s path (`endJob` in `server/job-records.mjs`). Nothing wakes it.
- **The agent’s state.** With a kept job and no turn, an agent already reads “waiting on a job: …” (`shared/agent-state.mjs`), after Send now or a Stop that kept jobs.
- **In the room.** Each kept job is listed under its reply with its own Stop (designs/intent.md, “Decisions and why”, the row that begins “Stop reaches every process of the turn”).
- **On a host.** The daemon records a turn’s tool shells’ groups and matches them by their members’ start times (`server/remote/host/daemon-kill.mjs`). `stopTurn` on a host ignores `keep`, so Send now keeps no jobs there today.

## The first step: Claude Code and the Agent SDK on this computer

This is where the pile-up was measured. The step is stop-and-keep: the turn ends as a finished turn at its reply, and the CLI is stopped with its jobs kept. Whether it or live input is built first for Claude Code here is open: see “Live checks before it’s built”.

```mermaid
sequenceDiagram
  participant H as The CLI (Claude Code, or the one the Agent SDK runs)
  participant S as Postbox
  participant J as The background job
  H->>J: run_in_background
  H-->>S: the reply’s result. Only shell jobs still run
  S->>S: ends the turn as finished: the reply is done, and its mentions wake
  S->>H: SIGKILL to the CLI’s group, keeping every tool shell
  Note over S: Running.busy() is false, and messages arrive
  loop every 5 s, while a kept job exists
    S->>J: is its process group still there?
  end
  J-->>S: gone
  S->>S: records the job’s end and one wake, in one commit
  S->>H: a new turn: “Your background job … has ended. Its output is in …”
```

- **When.** The reply’s `result` has arrived, and everything `on_turn_end` lists as still running is a shell job: a `run_in_background` Bash call, or one moved to the background at its timeout. With a background subagent or a Monitor running, see “When a turn still waits”.
- **The turn ends as a finished turn, not a stopped one.** It ends through `endTurn` with no error (`server/turn-finish.mjs`), as a turn whose CLI closed by itself does: its reply is `done`, its @-mentions wake, it goes back to its wakers, its lint and checks run, a scheduled wake’s turn settles as done, and nothing reads “Stopped”. A result with `is_error` still fails the turn. So the adapter needs a way to end the CLI that isn’t the turn’s abort signal: today `done()` returns early on an aborted signal, before the result’s error is read (`claude-code.mjs`). No stop is recorded and no stop reason is added.
- **Ending the CLI.** Only the process half of Send now is reused: `stopTurn`’s `keep`, with every listed job. It signals the CLI’s own group and no tool shell:
  - a job whose shell is found is kept in that shell’s group;
  - a job it can’t tell apart is kept with every unmatched shell, as Send now keeps it. So a gate that ran in the foreground, was fixed, and runs again in the background ends the turn like any other. Which shell is the job’s decides what its row is called and what its Stop reaches, never whether work is lost;
  - a listed job with no shell left has already ended, and its end and wake are recorded at once;
  - no shell is killed. At the result no foreground call is left to stop, so a shell that matches no job is left running, with no row and no Stop. That’s a change to `stopTurn` for this caller alone: Send now in the middle of a turn keeps killing the other shells.
- **The note at the next turn.** Every job kept at a reply gets Postbox’s counter-note, since the resumed CLI will say the job was stopped, and an agent that believes it runs the job again. Today’s two variants both name a stop, which would be false here. This path’s words: “Your background job … is still running: your turn ended at your reply, and the job runs on. If your CLI says it was stopped, that’s only because the process that started it has ended: it wasn’t stopped. Its output is in …. You’re woken when it ends.” The wake carries the same correction.
- **The wake.** When the kept-jobs poll sees a job’s group gone, Postbox records the end and one wake in one commit, sent the way a scheduled wake is delivered (`server/scheduled-wakes.mjs`). It’s an inbox entry with no schedule line and no Cancel, and it doesn’t count toward the agent’s 20 scheduled wakes. It carries the text the agent is told today: the job’s id, its command and its output file’s path. The agent reads the file with its own tools.
  - It goes only to the agent that started the job, counts as no hop, and raises no “needs you”.
  - A restart between seeing the end and sending the wake sends it once.
  - A job the person stopped wakes no one. The agent hears of it at its next turn, as today.
  - A job Postbox stopped at a clean shutdown, or recorded as stopped at a start after a crash, wakes its agent once after the start, and says which: see “Shutdown and restart” below.
  - Send now’s kept jobs wake their agent the same way, since they’re the same record.
- **Shutdown and restart.** A clean shutdown stops kept jobs (`stopKeptJobs` in `server/kept-jobs.mjs`, called from `server/turn-stop.mjs`), and a start after a crash records them as stopped, saying they may still run (`expireStaleJobs` in `server/job-records.mjs`). That stays. But on `main` a shutdown stops the waiting turn without settling what it took, and the restart reopens it once as a resend (`turn-stop.mjs`, `server/delivery.mjs`), so the agent gets a turn and learns its job is gone. After this step the agent is idle with a kept job, and nothing would start that turn, while its guide says it’s woken when the job ends. Each merge to `main` is a release, so restarts are frequent. So a job that a shutdown or a start ended wakes its agent once after the start.
- **What the step adds.** Not a marker in the environment, strict binding, an output tail read by Postbox, a new item in the room, a tool or a protocol message. It does add these, none of which `main` has:
  - a finished end for a turn whose CLI Postbox ends, above;
  - `stopTurn`’s keep without the kill of unmatched shells, for this caller;
  - the kind of each job. A Monitor is recorded as a job like any other today (`claude-stream.mjs`, `server/harness-tools.mjs`), so telling that everything listed is a shell job needs the job to carry its tool;
  - the wake at a kept job’s end, and after a shutdown or a start;
  - the counter-note’s words for this path;
  - a 2 h timer for Claude Code on this computer, with its stop and its note: see “When a turn still waits”. The SDK’s limit doesn’t bind the CLI (`sdk-background.mjs`’s opening comment), so Postbox needs its own.
- **The Agent SDK’s 2-hour wait no longer covers shell jobs.** The turn ends at the result, so the SDK’s limit is never reached for them, and “Postbox waits up to 2 h for background work after a reply” (`stoppedAfterReply` in `sdk-background.mjs`) is said only of a subagent or a Monitor. The limit itself stays until “Live input”, because without it the SDK stops a background subagent at 10 minutes (#1714).

### Live checks before it’s built

The first three haven’t been run. The fourth has one passing run for the Claude Code CLI and none for the Agent SDK. Each is a local run of a few turns with the real CLI, costs real usage, and is recorded here with its date, the CLI’s version and its fixture when it’s run.

| Check | What a pass shows | Result |
|---|---|---|
| The CLI is stopped after its `result`, while a `run_in_background` job runs | The job survives, and its output file keeps filling. Also what else sits under the CLI then, such as hooks or MCP servers, and whether any leads a process group of its own. #126’s recording stopped the CLI in the middle of a turn, not after a result | Not run |
| The session’s next turn, after that stop | It resumes, with a task id in its history that no CLI will ever report. The check records what the resumed CLI says about that task (#249), and that the agent, given Postbox’s counter-note, doesn’t run the job again | Not run |
| The Agent SDK’s run is ended after its `result` | Ending the run doesn’t itself stop the tasks, as reaching its limit does (#1714) | Not run |
| A new message during the wait, through `claude -p --input-format stream-json` with stdin held open | The CLI takes it as a new turn while the job runs on. This is the fully native fix: see “Live input” | **Passed once** (n=1, existence only), Claude Code 2.1.296: a message written to stdin 1 s after the result started a new turn in 46 ms, with its first token at 1,379 ms, while a `sleep 10` ran on. The job’s end then started a third turn, and the CLI exited 0. `tests/fixtures/delivery-routes.md`, “Claim 3”, with `tests/fixtures/delivery-routes/scenarioa-prime-framing1-plain-postresult.jsonl`, `scenarioa-prime-framing2-attributed-postresult.jsonl`, `scenarioa-prime-control-noinject.jsonl` and `timing-manifest.json` |
| The same, through the Agent SDK’s streaming input after a result | The same | Not run. Only input at a tool step’s boundary is recorded (`tests/fixtures/delivery-routes.md`, the backend table) |

If the first or third fails, stop-and-keep isn’t built for that backend as written, and this document says what was seen.

**Open, for the owner: which step is first for Claude Code on this computer.** The passing run shows the CLI can take a message while its job runs. It isn’t a build yet. What the recording says still stands between it and one (`tests/fixtures/delivery-routes.md`, “Claim 3”, “Scope & Limitations”):
- the adapter ends stdin with the prompt today (`child.stdin.end`, `server/adapters/claude-code.mjs`);
- the stream-json parity checks: `--resume`, `--session-id`, forks, slash commands, attachments, images and permission prompts;
- a message and a task notification that arrive together, which is unexercised;
- A′’s `openExecution` seam, proposed and not implemented (designs/508/delivery-routes.md, “Model turns and a live backend execution (A′)”).

Live input first stops nothing, covers subagents and Monitors, needs no wake from Postbox, and has no resumed CLI calling a job stopped. Stop-and-keep first needs none of the four items above, and leaves the two waits in “When a turn still waits”. The order table below shows stop-and-keep first and is corrected with the decision. The Agent SDK, hosts, Kiro, Antigravity and Codex have no passing run of live input after a result, so their steps don’t wait on this.

## When a turn still waits

A wait that costs the agent its messages needs a real risk, and says what it protects against. After each backend’s step, these are the only ones left:

| The turn waits | What the wait protects | What removes it |
|---|---|---|
| Before the model’s reply | Nothing to protect: the model is at work, and that’s what busy means. A message for it waits in its queue | Not a wait this design removes |
| A background subagent is still running | The subagent runs inside the CLI’s own process, with no process of its own to keep. Ending the CLI ends it, and its work is lost, as the two review rounds of #1714 were | “Live input” |
| A Monitor is still running | A Monitor’s lines reach the model only through the CLI that started it. Its script would survive the CLI, but nothing would read it, so the watch the agent asked for would be silently gone | “Live input” |

Both of the last two are bounded at 2 h (`QUIET.backgroundMax`), which the Agent SDK and hosts have today. Claude Code on this computer gains the same bound in the first step, so no backend holds an agent with no end. Past it the turn is stopped, and the agent is told what was stopped, as `sdk-background.mjs` tells it today. The bound protects against an agent deaf for good behind work inside its CLI that hung. The person’s Send now still ends such a wait at any moment.

Nothing else waits. In particular, a turn never waits because Postbox couldn’t tell which process is a job’s.

## The order, and what each backend does until its step

Each step is its own change, with its own live check, and lands in this order. The order follows the evidence: the measured waits first, then the same wait where it’s already bounded, then the wait that’s reasoned from a probe, then the backend where no message waits today.

| Order | Backend | Until its step lands | The bound until then | After its step |
|---|---|---|---|---|
| 1 | Claude Code and the Agent SDK, this computer | Today’s wait | None for Claude Code, 2 h for the Agent SDK | Free at the reply. A subagent or a Monitor: at most 2 h |
| 2 | Claude Code on a host | Today’s wait | 2 h (#847) | The same as step 1 |
| 3 | Kiro and Antigravity, here and on a host | Today’s wait for an unredirected `cmd &`. A redirected job already frees the agent, with no wake | None on this computer. Not verified on a host: see “The problem” | Free at the reply, with a wake |
| 4 | Codex, here and on a host | No message waits behind a background job, since none survives the turn: the guide says to run the command in the foreground, and a message waits for that call | The command’s run | Background work is kept, with a wake |
| 5 | Live input, per backend, where its check passes. For Claude Code on this computer its place is the open decision above | The waits in “When a turn still waits” | 2 h | No wait after a reply |

Kiro and Codex run on hosts today, and Antigravity doesn’t yet (`server/adapters/adapter.mjs`, the `remote` capability). Each gets its step on a host in the same change as on this computer, and Antigravity’s host step comes with its host support.

### Hosts

A turn on a host waits up to 2 h today, and Send now keeps nothing there. The step for a host:
- **The laptop decides, and the daemon keeps.** Postbox on the laptop already reads the turn’s stream, so it applies the first step’s rule and sends the daemon’s `stop` with the jobs to keep. A message can reach an agent only while the laptop is up, because delivery runs there. So deciding there loses nothing: if the result came while the laptop slept, the stop goes out when it reconnects and reads the stream.
- **The daemon’s stop gains `keep`** (`daemon-kill.mjs`): SIGKILL to the runner’s group at once, and the tool shells’ groups it already records are kept, each matched by its members’ start times as today.
- **The daemon polls its kept groups** and stores each job’s end in its own data folder, never in the workspace, while the laptop sleeps or the link is down.
- **Send now on a host keeps jobs too,** since it’s the same stop.
- **Kiro’s step on a host runs in the daemon:** it reads the runner’s group after the harness’s `exit`, and again 1 s later, as “Kiro and Antigravity” says.
- **Codex’s step on a host runs in the daemon too:** the signals by pid, each checked against its start time, as “Codex” says.

```mermaid
sequenceDiagram
  participant L as Laptop (Postbox)
  participant D as Host daemon
  participant J as Job on the host
  D-->>L: the turn’s stream, with its result and a shell job still running
  L->>D: stop, keeping the job
  D->>D: SIGKILL to the runner’s group, keeps J’s group
  D-->>L: the turn ended, and jobs.kept
  Note over L: The agent is free, and messages arrive
  Note over L,D: the laptop sleeps, and the link drops
  J-->>D: ends (seen by the daemon’s poll)
  D->>D: stores J’s end
  Note over L,D: the laptop reconnects
  D-->>L: welcome (lists jobs), then jobs.list
  L->>L: records J’s end and one wake, in one commit
  L->>D: jobs.ack
  D->>D: drops J’s record
```

The protocol messages: `jobs.kept` and `jobs.ended` (daemon to laptop, live), `jobs.list` (daemon to laptop on reconnect), `jobs.stop` and `jobs.ack` (laptop to daemon). A daemon from before this change doesn’t list `jobs` in its welcome, and with one the laptop keeps today’s wait and its 2 h bound. That follows the welcome-field pattern `claudeChecks` uses (`server/adapters/claude-code-remote.mjs`, and remote-hosts.md, “Postbox and the daemon”). While a host is disconnected its jobs read as last seen at a time, never as an alarm.

Its live check: the first step’s first two checks, run on a host, and a job that ends while the laptop is disconnected. For Kiro on a host: what a turn does today while an unredirected `cmd &` runs, and Kiro’s own check. For Codex on a host: Codex’s own check.

### Kiro and Antigravity

These CLIs exit by themselves after the reply, and Postbox sends no signal at a normal end. The wait is only the held `close`.
- **The turn ends at the terminal event and `exit`, not at `close`.** The terminal event is Kiro’s `runFinished` or `runError` (`kiro-cli.mjs`; `runError` sets no `finished` today, so the step treats it as terminal too), or Antigravity’s `result` event.
- **When the terminal event lags `exit`,** Postbox keeps reading stdout for up to 2 s. If the event arrives, the outcome follows `main`’s order for a closed CLI. If not, the turn ends as `main` ends a CLI that exited without its final event: the reply read so far is kept, and the turn fails with the exit error.
- **The pipes stay drained.** Postbox doesn’t close its ends of the CLI’s stdio, because a job writing to a pipe with no reader gets SIGPIPE and dies: a probe killed a backgrounded `echo` that way, status 141 (during #1615’s review). Postbox reads each pipe to EOF and discards what comes after the turn’s end. So the job runs to its end exactly as on `main`, where the turn would have waited for it.
- **What’s kept is what’s left.** After the CLI’s exit, whatever is still in its process group is work the turn left running. Nothing is signaled, as on `main`. The group is recorded as one kept job, with the command of each member as its label, only if it’s still there at a second read 1 s later, so a helper that outlives its CLI by milliseconds wakes no one. The turn’s end doesn’t wait for that read.
- **The wake** is the first step’s, when the group is empty. Its text names no output file: a job that redirected its output is the agent’s to read, and one fed through the CLI’s pipes had its output discarded, which the wake says.
- **Stop is `main`’s Stop.** It kills the turn’s group, background work included, between the CLI’s exit and its `close` too.

Its live check, per CLI: at a normal end, does the CLI exit with `&` and `nohup` work left in its group? Does `close` fire while an unredirected `cmd &` runs, or only when it ends? Does a turn with no background command leave nothing in the group?

### Codex

Codex’s turn already ends at the reply, so no message waits. What’s missing is the job: Postbox stops the app-server’s whole group at each turn’s end, so an agent that wants a long command to finish has to hold its turn open for it.
- **At the turn’s end the app-server is still alive,** so its group holds two kinds of member, and the parent tells them apart:
  - **Background:** a member whose parent is init or the subreaper, and whose start time falls inside the turn. Its shell exited and left it running, which is what `cmd &` and `nohup cmd &` do. A fake harness running `/bin/sh -c 'node -e … & echo $!'` showed the shell living 4.7 to 4.9 ms and its child’s parent becoming pid 1, in the group the shell had (during #1615’s review). It’s kept, with its descendants.
  - **Everything else:** the app-server, its helpers and any call still running. It’s stopped, as on `main`.
- **A group that holds a kept member can’t take a group signal,** so each other member is signaled by its own pid: SIGINT, then SIGKILL after `GRACE_MS` to whatever a fresh read of the group still shows, kept members and their descendants spared. Before each pid signal Postbox reads that pid’s start time again and skips one that changed, since a reused pid is the risk of signaling by pid. The local `ps` read (`listProcesses`) gains `lstart` for this.
- **A group with no background member** gets the group signal `main` sends.
- **The wake** is the first step’s. `TURN_ENDS` goes from Codex’s guide in the same change.

Its live check: does the app-server end a turn while a backgrounded child runs, and what does it do to that child? Is a backgrounded child still in the app-server’s group, with init as its parent? Does a turn with no background command keep nothing?

### Live input

The fully native fix keeps the CLI alive and hands it the new message as a new turn while its background work runs on. Then nothing is stopped: subagents and Monitors are covered, the harness reports each task’s end and exit status itself, and no wake from Postbox is needed for that backend.

Its design is designs/508/delivery-routes.md, “Model turns and a live backend execution (A′)”, which names this state `background-wait`; its “Caller sweep: one lifetime used for two facts” makes it “eligible only through proven live input”. Its proof is the fourth and fifth checks in “Live checks before it’s built”, and for the Claude Code CLI it has one passing run, with what still stands between that and a build listed there. Where it’s proven and built for a backend:
- the backend takes live input in place of stop-and-keep;
- the waits in “When a turn still waits” go, for that backend;
- #1801’s limit goes: `backgroundWaitEnv` and `stoppedAfterReply` (`sdk-background.mjs`) for the Agent SDK, and the 2 h bound on a host’s waiting turn for Claude Code there.

Where it doesn’t pass, or for a harness with no such input, the steps above stand, and the two waits keep their 2 h bound.

## What the room shows

The first step adds no surface. A kept job already has its row under its reply, with its Stop, and shows its end there. The wake is an inbox entry like any other.

One line changes, because it’s wrong. An agent with a kept job and no turn reads “waiting on a job: …” (`jobOf` in `shared/agent-state.mjs`, `stateWords` in `app/js/agents.mjs`). That state is reached only when no turn runs, so it’s already said of a free agent on `main`, after Send now or a Stop that kept jobs. The agent isn’t waiting on anything, and a person or an agent who reads “waiting” would hold their message back. The state reads “job running: …” on every backend, in the first step’s change, which also updates the two docs that name the state: designs/rooms-at-scale.md, “Live state: what each agent is doing”, and designs/architecture/services.md, “Delivery and Turns, built as the inbox”. A turn still held by a subagent or a Monitor keeps its running step, “Waiting for a background subagent” or “Waiting for a background job”, which is true of it.

Stopping a job:
- **The person** stops any listed job with its row’s Stop.
- **An agent** has no Postbox tool for it, and gets none. It stops a job it started the way it stops any process, with its harness’s shell tool, under its persona’s mode.

## The guide and intent.md

- **A backend whose step has landed** gets one line in its guide: “Background work is fine: you’re woken when it ends.” For Codex it replaces `TURN_ENDS`. Without it an agent that doesn’t know of the wake polls its job with `sleep`, which holds its turn open as before.
- **A backend whose step hasn’t landed** keeps what its guide says today.
- **designs/intent.md** states the rule under “Function first”, says in its sessions row that background work isn’t busy, and says in its scheduled-wake row that a kept job’s end wakes its agent. Each marks what’s planned.

## How it’s tested

The first step:
- **The room outcome, through the normal turn path,** with recorded Claude Code and Agent SDK streams. #1614’s recorded stream, where the message waits, is the baseline, and the test fails on `main`.
  - A turn whose result lists only shell jobs ends at its `result`, and its reply is `done`, not stopped.
  - An @-mention in that reply wakes its agent, and the turn goes back to its wakers.
  - A result with `is_error` still fails the turn.
  - The agent’s next turn is told its job runs on, and not that anyone stopped its turn.
  - A room message reaches the agent while the job runs.
  - The job’s end wakes the agent exactly once, including with a restart between seeing the end and sending the wake.
  - A job stopped by a clean shutdown, and one recorded as stopped at a start, each wake their agent once after the start.
  - A turn whose result lists a background subagent or a Monitor doesn’t end early, and is stopped at 2 h with the agent told.
- **`tests/process/`, with real processes:**
  - the same command run in the foreground earlier in the turn, then in the background: the turn ends, and the job survives;
  - two background jobs with the same command: both survive, and each wakes once;
  - a listed job that has already exited: its end and wake are recorded at once;
  - Send now in the middle of a turn still kills the turn’s foreground shells.
- **Unit tests:** the wake counts as no hop, raises no “needs you”, and doesn’t count toward the 20 scheduled wakes; a job the person stopped wakes no one; the agent’s state words.
- **A browser spec** for “job running: …” on a free agent, run plain and with `POSTBOX_STREAM_LAG=300`.

Each later step adds its own, on the same pattern:
- **Hosts:** a fake daemon through a kept stop, a disconnect, an exit while away and a reconnect. A second reconnect wakes no one, and an old daemon’s welcome keeps today’s wait.
- **Kiro and Antigravity:** a fake harness in both stdio layouts. With `cmd` unredirected, the turn ends at `exit`, the job keeps writing, isn’t killed by SIGPIPE, and wakes its agent once. A CLI that exits without its terminal event fails the turn after 2 s with the reply read so far. A helper gone at the second read wakes no one.
- **Codex:** a mixed group, where the background member survives and a foreground child stops, each signaled by its own pid. A child started during the grace period is reaped. A reused pid is skipped.

## Later, not part of #1614

None of these stops messages piling up behind a background job, so none is part of #1614 or blocks a step above. Each needs its own evidence and its own issue before it’s built, and the earlier draft’s detail for each is in this file at [f749d8aed](https://github.com/HJeon139/postbox/blob/f749d8aed2c3ec4062b19a5ee9e6dcc683f8439a/designs/architecture/background-processes.md).

- **Whose process is this?** ([#1606](https://github.com/HJeon139/postbox/issues/1606)). Processes that escape a harness’s group, after `setsid` or as the orphan of a tool shell that led its own group, belong to no session Postbox can name. The earlier draft marked every harness process with `POSTBOX_SESSION` and `POSTBOX_TURN` in its environment and scanned for them (`ps -E` on macOS, where Apple’s own binaries hide their environment; `/proc/<pid>/environ` on Linux). That is #1606’s design to make. Until then such a process is what it is on `main`: untracked, with no wake. The first step adds one small source of these: a tool shell that matches no listed job is left running at the reply, where on `main` the live CLI still owns it.
- **Processes Postbox can see but can’t stop or wake for.** The earlier draft showed them in the room as “informational”. A row nobody can act on isn’t added (AGENTS.md, “No unactionable alarms”).
- **Telling one job’s shell from another’s exactly.** The strict rules (one matching shell, started inside its call, no other call with the same command) would sharpen a job’s label and its Stop. They never decide whether a turn ends. Worth building only if the lenient keep is seen to stop the wrong job.
- **An output tail in the wake.** Postbox reading a job’s output file needs the checks that keep it from reading a file the agent’s Read rules deny. The wake names the file, and the agent reads it.
- **`tmux`.** A session started with `tmux new -d` outlives its turn on every backend today. Naming it in a wake needs the marker above.
- **Jobs that survive a Postbox restart.** A kept job is stopped at a clean shutdown, as on `main`. Keeping it across an upgrade means telling a job fed through a CLI’s pipes from one that isn’t (`lsof` at shutdown) and adopting it again at startup.

## When to revisit

- When a live check is run: its result goes in its table here, pass or fail, and a failed check changes its step in the same change.
- If a kept job’s Stop is seen to stop the wrong shell, or a wake names the wrong job, build the exact matching under “Later, not part of #1614”.
- If agents are seen holding their turns open with `sleep` after their backend’s step lands, the guide line isn’t working, and the fix is there.
- If a wait in “When a turn still waits” is measured holding messages after its backend’s step, it moves up the order ahead of whatever is next.
