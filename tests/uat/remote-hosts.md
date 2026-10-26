# Remote hosts: the live checklist

**Where:** Settings › Hosts (each host’s card), a persona’s **Runs on**, the agent’s row and ring, and the callouts under a reply whose turn ran on a host.

## Why it exists

An agent’s turns can run on another machine you reach with `ssh`, while Postbox stays on your computer (#120; README, “Run agents on a remote host”; designs/architecture.md, “Remote hosts”). Only the agent’s process moves, so everything that can go wrong between two machines now can: a sign-in, a host key, a dropped connection, a sleeping laptop, logind ending processes at logout, a harness whose sign-in ran out on the host.

`npm run test:integration` runs the whole pipeline with only ssh replaced: the real install script, launcher, daemon, runner and shim, on this computer, against a stand-in harness that replays recorded Claude Code lines. What it can’t show is everything this page checks: real `ssh` and its authentication, a real Linux host’s systemd and logind, the real harnesses, and waits measured in hours. The headless checks (`node tools/check-all.mjs hosts remote`) cover the UI with a scripted host.

The order matters. SSH and authentication come first, since nothing else works without them; then systemd and logind, which decide whether a turn survives at all; then Claude Code in depth; then one compatibility turn each for Kiro CLI and Codex; then the long waits; and Remove last, since it deletes everything. Clean up (section 7) comes after that, and also after any failure or whenever you stop early: it puts back what the steps changed on both machines.

## Before you start

You need:
- **A Linux host** you reach with `ssh`, written `host.example.com` here. Use your alias from `~/.ssh/config` if you have one. `ssh -o BatchMode=yes host.example.com true` must exit without asking anything.
- **On the host:** Node 22 or later, and Claude Code, Kiro CLI and Codex installed and signed in as your user. `jq` isn’t needed; the commands below use `sed`.
- **Personas:** one Claude Code persona in **Ask me**, one Kiro CLI persona and one Codex persona in **Auto**. Each gets **Runs on: host.example.com** in section 1.

Then prepare, in this order. Some steps change things outside Postbox: your ssh agent and known hosts here, and lingering and Claude Code’s sign-in on the host. What you record now is what Clean up (section 7) puts back.
1. **A temporary ssh agent, here,** so that 1.3 can empty it without touching your usual one. In the terminal you’ll run Postbox in:

   ```bash
   eval "$(ssh-agent -a /tmp/pb-uat-agent.sock)"
   ssh-add ~/.ssh/id_ed25519                      # the key you sign in to host.example.com with
   ssh -o BatchMode=yes host.example.com true     # must exit without asking anything
   ```

   This works when ssh can’t use your key without an agent, such as a key file with a passphrase. If your key lives only in another agent (a password manager’s, or one your `~/.ssh/config` names with `IdentityAgent`, which overrides this one), skip this step, and instead run `ssh-add -l` and note each key it lists, so you can add them back after 1.3.
2. **A backup of your known hosts, here,** readable only by you (`0600`), under a name only this run uses. 1.5 and Clean up restore exactly this file, so note the name it prints in case this terminal closes:

   ```bash
   export PB_UAT_KH="$HOME/.ssh/known_hosts.uat-$(date +%Y%m%d-%H%M%S)-$$"
   (umask 077; cp ~/.ssh/known_hosts "$PB_UAT_KH")
   ls -l "$PB_UAT_KH"                             # -rw-------
   ```

   In a new terminal, set it again first: `export PB_UAT_KH=<the name it printed>`.
3. **Lingering, on the host.** Note what this prints, `Linger=yes` or `Linger=no`; sections 2 and 7 change it and put it back:

   ```bash
   loginctl show-user "$USER" -p Linger
   ```
4. **Postbox, here,** in the terminal from step 1, so its `ssh` uses the temporary agent: `node server/index.mjs --port 4181 --data /tmp/pb-uat-remote --fresh`, then open <http://127.0.0.1:4181/>. To restart it later in the pass, use the same terminal and leave out `--fresh`. The host’s token here is in `/tmp/pb-uat-remote/remote-tokens/`.

**The newest turn on the host,** for the commands below, run on the host:

```bash
t=$(ls -t ~/.postbox-remote/turns | head -1); d=~/.postbox-remote/turns/$t
pid=$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' $d/runner.json)   # the runner, which leads the turn’s process group
```

## Where to look when a step fails

| What           | Where                                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Postbox’s side | The terminal running `server/index.mjs`, and the host’s card in Settings › Hosts, which shows the failure and its next step                                                                                                          |
| ssh itself     | `ssh -v -o BatchMode=yes host.example.com true` in a terminal here                                                                                                                                                                   |
| The daemon     | `~/.postbox-remote/<version>/daemon.log` on the host (the one before it is `daemon.log.1`). It logs each turn it starts, and whether in a systemd user scope                                                                         |
| A turn         | `$d` on the host: `out.jsonl` (the harness’s stdout), `err.log` (its stderr, and why a runner refused to start), `exit.json` (how it ended), `runner.json` (its process ID, boot ID and start time), `in.jsonl` (Codex’s held stdin) |
| What’s running | `pgrep -u "$USER" -fa '\.postbox-remote'` on the host; `pgrep -a -g $pid` for one turn’s process group                                                                                                                               |
| Listeners      | `ss -ltnp` on the host; `lsof -nP -iTCP -sTCP:LISTEN` here                                                                                                                                                                           |

A finished turn’s `out.jsonl`, `in.jsonl` and `err.log` are deleted once Postbox has read all of `out.jsonl`, so look before the turn ends, or right after. `exit.json`, `runner.json` and `start.json` stay until the folder goes, after logRetention (7 days).

## 1. SSH and host authentication

**1.1 Install, and its confirm**
- **Steps:** Settings › Hosts. Under **Add a host**, type `host.example.com` and press **Add host**. On its card, press **Install…**, read the confirm, open **The commands ssh runs there**, and press **Install**. Then press **Install…** again and install a second time.
- **You should see:** before installing, “Postbox’s host program isn’t installed on host.example.com yet”. The confirm, “Install Postbox on host.example.com?”, lists four steps: connect with your ssh without a password or host-key prompt; copy Postbox’s host program to `~/.postbox-remote/<version>/` readable only by you (folders 0700, files 0600) and check each file’s SHA-256; find Node 22 or later (or write `node-path`, if Node’s path is set); make the token at `~/.postbox-remote/token` (0600) and keep a copy here. It ends “Nothing runs as root, and nothing outside ~/.postbox-remote changes on host.example.com.” Then the toast “Installed Postbox on host.example.com”, and the second time “This Postbox was already on host.example.com”. On the host, `ls -la ~/.postbox-remote` shows `drwx------` and `token` as `-rw-------`; here, `ls -l /tmp/pb-uat-remote/remote-tokens/` shows one `-rw-------` file.
- **If not:** the confirm shows the failure and its next step in place. An exit code from the install script names what failed (files that didn’t arrive whole, a SHA-256 that didn’t match, no `sha256sum`, `shasum` or `node`, a symbolic link). For a missing Node, the message says where the launcher looked.

**1.2 Placing a persona**
- **Steps:** Settings › Personas, the Claude Code persona, **Runs on: host.example.com**, Save. Do the same for the Kiro CLI and Codex personas.
- **You should see:** the help under Runs on says its turns run on host.example.com over your own ssh, and Postbox and its tools stay here. Once Postbox has connected (section 3.1), a persona whose CLI the host doesn’t have is refused, saying where the daemon looked.

**1.3 Sign-in fails**
- **Steps:** make ssh unable to sign in without asking. With the temporary agent from Before you start, empty it, in a second terminal here:

  ```bash
  export SSH_AUTH_SOCK=/tmp/pb-uat-agent.sock    # the temporary agent, not your usual one
  ssh-add -D
  ssh -o BatchMode=yes host.example.com true     # now fails with “Permission denied”
  ```

  With your usual agent instead, check that you noted what `ssh-add -l` lists, then run the last two lines without the `export`. With a certificate, move it aside instead (with your certificate’s file name): `mv ~/.ssh/id_ed25519-cert.pub ~/.ssh/id_ed25519-cert.pub.uat`, and check the same way. Send the Claude Code agent a message. Then put the key back in that terminal (`ssh-add ~/.ssh/id_ed25519`, once for each key you noted) or the certificate (`mv ~/.ssh/id_ed25519-cert.pub.uat ~/.ssh/id_ed25519-cert.pub`), and press **Reconnect** on the host’s card.
- **You should see:** the card reads **Failed**, “Postbox couldn’t sign in to host.example.com: ssh had no key or certificate it could use without asking.”, then “Sign in to host.example.com in a terminal (run `ssh host.example.com`), then reconnect.”, with the command and **Copy**. Postbox doesn’t try again on its own: it stays Failed until you press **Reconnect**, then reads **Connected**.
- **If not:** run the `ssh -v` command above and compare its last lines with the card’s; the card quotes what ssh said.

**1.4 A host key ssh doesn’t know**
- **Steps:** here, check that the backup from Before you start is there (`ls -l "$PB_UAT_KH"`), then `ssh-keygen -R host.example.com` (with an alias, use its `HostName`). From here to the end of 1.5, if you stop, restore the backup first (Clean up, step 4). Send the agent a message. Then run `ssh host.example.com`, check the fingerprint, accept it, and press **Reconnect**.
- **You should see:** “ssh doesn’t know host.example.com’s host key yet, and it won’t accept a new one without asking.”, then “Connect once in a terminal with `ssh host.example.com`, check that the fingerprint it shows is the host’s, accept it, then reconnect.” After Reconnect, **Connected**.

**1.5 A host key that changed**
- **Steps:** here, `ssh-keygen -R host.example.com`, then add another machine’s key under this host’s name: `ssh-keyscan -t ed25519 other.example.com | sed 's/^[^ ]*/host.example.com/' >> ~/.ssh/known_hosts`. Send the agent a message. Then restore this run’s backup, `cp "$PB_UAT_KH" ~/.ssh/known_hosts`, and press **Reconnect**.
- **You should see:** “host.example.com’s host key has changed since you last connected, so ssh refused it. The host may have been rebuilt, or someone may be intercepting the connection.”, then a next step to check the key with whoever runs the host, `ssh-keygen -R host.example.com` (with the file and line ssh found it at), connect once, then reconnect. It must never read as a sign-in failure.

**1.6 Busy, and taking over**
- **Steps:** start a second Postbox, `node server/index.mjs --port 4182 --data /tmp/pb-uat-remote-2 --fresh`, add the same host and install (it says the version is already there). Place a Claude Code persona on it. In the first Postbox, ask the agent: “Use the Bash tool to run exactly: sleep 100. Then reply done.” While it runs, send the second Postbox’s agent a message. On its host card, press **Take over…**, read the confirm, and press **Take over**.
- **You should see:** the second Postbox’s card reads “Another Postbox is using host.example.com.”, quoting the daemon, with **Take over…**. The confirm says only one Postbox can drive a host at a time, that taking over disconnects the other one, and that turns already running there keep running. After it, the second Postbox reads **Connected** and its turn runs. The first Postbox’s turn goes on on the host (`pgrep -a -g $pid`). Record what the first Postbox shows once it tries again: it should read busy, with its own **Take over…**, never a sign-in or host-key failure.

## 2. systemd and logind

On the host, check how logind ends processes, and whether lingering is on:
```bash
busctl get-property org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager KillUserProcesses   # b true or b false
loginctl show-user "$USER" --property=Linger                                                                       # Linger=yes or Linger=no
```
With `b false`, turns run without a systemd scope and survive a logout either way, and Postbox shows no warning: check 2.1 only. With `b true`, the daemon puts each turn in a systemd user scope (its log says “in a systemd user scope”): check 2.1 and 2.2. A host with `b true` is the one this section is for; if you have only `b false` hosts, say so in the results.

The long turn for this section, sent to the Claude Code agent (in **Run everything**, or allow each call): “Use the Bash tool five times, one call after another, each running exactly: date >> ~/pbx-linger.log; sleep 100. Then reply done.” Each call stays under the Bash tool’s own time limit.

**2.1 Lingering on: a turn survives your last logout**
- **Steps:** on the host, `loginctl enable-linger` and `rm -f ~/pbx-linger.log`. Send the long turn. After its first step, quit Postbox (Ctrl-C), and log out of every session you have on the host. Wait 5 minutes. Then `ssh host.example.com 'cat ~/pbx-linger.log; ls ~/.postbox-remote/turns/*/exit.json'`, and start Postbox again without `--fresh`.
- **You should see:** the log’s times carry on through the minutes nobody was logged in. After the restart, the reply streams in again from the start, replacing the partial one, and ends **done** once; no step appears twice.
- **If not:** `daemon.log` (was the turn scoped?), the turn’s `exit.json` (a signal means something ended it), and `journalctl --user -n 50` on the host.

**2.2 Lingering off: the warning, and what happens at logout**
- **Steps:** on the host, `loginctl disable-linger` and `rm -f ~/pbx-linger.log`. Send the agent a short message (“Reply ready”). When it’s done, send another within 30 minutes, then open the host’s card. Then send the long turn, quit Postbox after its first step, log out of every session on the host, wait 5 minutes, check the log as in 2.1, and start Postbox again.
- **You should see:** the host’s card warns “Turns on host.example.com end when your last session there does”, says lingering is off, and gives `loginctl enable-linger` with **Copy**. It shows from the first connection, before any turn has run, and goes once lingering is on. At logout, the docs say the scope ends: the log should stop when you logged out, and after the restart the reply should read **Interrupted on host.example.com**, then resume on its own. Record what happened; it settles a “Still to confirm” row (section 5).

Turn lingering back on (`loginctl enable-linger`) for the rest of the pass, unless you want to test without it. Clean up puts back the value you noted before you started.

## 3. Claude Code

Use the Claude Code persona in **Ask me**, placed on the host. Remove is the last step of the whole pass (section 6).

**3.1 A turn**
- **Steps:** ask: “Use the Bash tool to run exactly: uname -a. Then reply with its output.” Allow the card. While it runs, run `ss -ltnp` on the host and `lsof -nP -iTCP -sTCP:LISTEN` here.
- **You should see:** the agent’s row reads “On host.example.com · Connected · last heard from …”. The reply streams, shows the host’s `uname`, and ends done. The host’s card now lists Node and the three harnesses, each with its version and path. The listeners are the same as before the turn: nothing of Postbox’s listens on TCP on the host, and only Postbox’s own port 4181 here. Work shows the command; files changed on the host read “not recorded”.
- **If not:** the terminal here, then `daemon.log` and the turn’s `err.log`.

**3.2 A block**
- **Steps:** ask: “Show me a choice block asking which of three colors I like.” Answer it.
- **You should see:** the block appears in the conversation as it would for an agent here, and the agent hears your answer on its next turn.

**3.3 A permission card answered after more than a minute**
- **Steps:** ask: “Use the Bash tool to run exactly: touch /tmp/pbx-uat-wait.” When the card appears, wait 3 minutes, then press **Allow**.
- **You should see:** the card is still open after 3 minutes, and the agent stays “Waiting on you”, not Hung. After Allow, the command runs (`ls /tmp/pbx-uat-wait` on the host) and the turn ends done.
- **If not:** the turn’s `out.jsonl` (does the result say the tool call timed out?) and `claude --version` on the host (2.1.187 or later).

**3.4 A permission card answered after the laptop slept**
- **Steps:** as 3.3, with `/tmp/pbx-uat-sleep`. When the card appears, close the laptop’s lid for 10 minutes. Open it, and press **Allow** once the host reads Connected.
- **You should see:** Postbox reconnects on its own after the wake, without your opening anything. The card is still open, and Allow runs the command.

**3.5 Stop**
- **Steps:** ask: “Use the Bash tool to run exactly: sleep 100. Then reply done.” Press **Stop** while it sleeps. Then repeat with a background job: “Use the Bash tool with run_in_background set to true to run exactly: sleep 300. Then reply started.”, and press Stop.
- **You should see:** “Stopping on host.example.com” beside the agent, then “Stopped by you”, within about 10 seconds. On the host, `pgrep -a -g $pid` prints nothing, and `exit.json` records the signal. With the background job, Stop says first that the job stops with the turn, and offers no “Keep running”; afterward `pgrep -fa 'sleep 300'` on the host prints nothing.

**3.6 Hung**
- **Steps:** in the host’s settings, set **Stop a quiet turn after** to 10 min. Ask: “Use the Bash tool to run exactly: sleep 60. Then reply done.” While it sleeps, freeze the harness on the host: `kill -STOP $(pgrep -P $pid)`. Wait 11 minutes.
- **You should see:** the reply stops with the note “Stopped: no output for 10 min (the last at HH:MM)”, and a notification that the agent was stopped. Afterward `pgrep -a -g $pid` prints nothing. Set the setting back to 15 min.
- **If not:** the time while Postbox can’t reach the host doesn’t count, so keep the laptop awake and connected throughout.

**3.7 The connection drops while a permission prompt waits**
- **Steps:** as 3.3, with `/tmp/pbx-uat-drop`. When the card appears, turn off this computer’s network for 2 minutes. Press **Allow** while it’s off. Turn the network back on.
- **You should see:** after about 45 seconds the agent reads Reconnecting, then, once the network is back, Connected again on its own. The card keeps your answer, and the command runs once the host is back (`ls /tmp/pbx-uat-drop`). The reply goes on with no line twice.
- **If not:** the terminal here (the reconnect attempts), `daemon.log` on the host (each attach, and the prompt sent again after hello).

**3.8 Postbox restarts mid-turn**
- **Steps:** ask: “Use the Bash tool to run exactly: for i in 1 2 3 4 5 6; do echo $i; sleep 10; done. Then summarize.” Allow it. Partway through, quit Postbox (Ctrl-C) and start it again without `--fresh`.
- **You should see:** the turn goes on on the host while Postbox is down (`out.jsonl` grows). After the restart, the reply streams in again from the start, replacing the partial one, and ends once, with each step once.

**3.9 Interrupted, and resuming on its own**
- **Steps:** as 3.8, but partway through kill the turn’s whole process group on the host: `kill -KILL -- -$pid`.
- **You should see:** the reply reads “Interrupted on host.example.com · The agent’s process there ended without finishing its turn.”, with Resume and a line saying Postbox resumes it on its own once the host is back. Since the host is up, Postbox resumes it at once: the agent’s next turn is told its last one stopped, and carries on. After three interruptions in a row, it waits for **Resume** instead.

**3.10 Sign-in needed, with no sign-in check**
- **Steps:** make Claude Code’s sign-in fail on the host: with a subscription sign-in, `mv ~/.claude/.credentials.json ~/.claude/.credentials.json.uat`. Send the agent a message. Wait 10 minutes. Then move the file back (`mv ~/.claude/.credentials.json.uat ~/.claude/.credentials.json`) and press **Resume**. If you stop before moving it back, Clean up’s step 6 does it.
- **You should see:** the reply reads “Sign-in needed on host.example.com · Sign in there, then resume @agent.”, then “Resume it once you’ve signed in.”, with **Resume**. Nothing resumes on its own in the 10 minutes. After Resume, the agent is told why its last turn stopped, and carries on.
- **If not:** the turn’s `out.jsonl`: Postbox recognizes a `result` with `is_error: true` and `error: "authentication_failed"`. If a missing sign-in ends the turn some other way, record the last lines; they’re not the expiry the probes recorded, so this is a finding about the check, not necessarily about Postbox.

**3.11 Sign-in needed, with a sign-in check**
- **Steps:** in the host’s settings, set **Sign-in check** to three lines: `test`, `-f`, `/tmp/pbx-signed-in` (and make sure that file doesn’t exist on the host). Move the credentials aside as in 3.10 and send a message. Move the credentials back, and wait 6 minutes. Then `touch /tmp/pbx-signed-in` on the host, and wait up to 6 minutes more.
- **You should see:** before the turn, a notification “Sign-in on host.example.com may have run out”, saying the check failed with exit code 1; the turn still starts. It ends “Sign-in needed”, with “Postbox resumes it on its own once host.example.com’s sign-in check passes.” While the file is missing, it never resumes, even with the credentials back. Within about 5 minutes of the file appearing, Postbox resumes it on its own and the agent carries on. Clear the setting afterward.

**3.12 The idle exit leaves nothing running**
- **Steps:** in the host’s settings, set **Daemon’s idle time** to 1 min. Let a turn end, touch nothing for 5 minutes, then run `pgrep -u "$USER" -fa '\.postbox-remote'` on the host.
- **You should see:** nothing: no daemon, no relay, no runner, no shim. (Postbox closes its own connection 2 minutes after nothing needs it, and the daemon exits a minute later.) The host’s card reads Disconnected, and the next message connects again on its own. Set the setting back to 30 min.

## 4. Kiro CLI and Codex

**4.1 Kiro CLI: a resumed turn through stdin**
- **Steps:** ask the Kiro CLI agent: “Show me a card block that says hello, then reply done.” Ask a follow-up in the same conversation, so it resumes.
- **You should see:** both turns answer, the second keeps the first turn’s context, and neither turn shows a host privacy warning. During each turn, the message is absent from the Kiro process’s arguments. The card block appears, so Postbox’s tools reached it over the shim. There’s never a permission card: headless Kiro refuses what it would ask.
- **If not:** `err.log` in the turn folder, and whether `kiro-cli` was found (the host’s card).

**4.2 Codex: one turn, its approvals, and Stop**
- **Steps:** ask the Codex agent: “Reply ready.” Then: “Use your shell to run exactly: touch ~/pbx-codex-uat.” (outside its working folder, so its sandbox asks). Press **Allow**. Ask again with `~/pbx-codex-uat-2` and press **Don’t allow**. Then: “Use your shell to run exactly: sleep 100.”, and press Stop.
- **You should see:** each approval arrives as a permission card. Allowed, the file exists on the host; refused, it doesn’t, and the agent says so. Stop ends the turn, and `pgrep -a -g $pid` prints nothing.
- **If not:** the turn’s `out.jsonl` (the approval request) and `in.jsonl` (the answer Postbox wrote to the held stdin).

## 5. Still to confirm

Each row of designs/architecture.md’s “Still to confirm” that a live run settles. These take hours or days, so start them early and let them run alongside the rest. Record each result on #120 (no host names, user names or sign-in details: the repo and its issues are public), with the harness’s version.

| Question                                                              | How to run it                                                                                                                                                            | Record                                                                                       |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Does a 24-hour Claude Code permission wait pass over the shim?        | As 3.3, leave a card for 23 hours, then **Allow**. Leave a second for over 24 hours. Only the shipped setup (the shim’s `timeout` plus progress) can be run from the app | Whether the first runs; whether the second ends “expired” with the agent told no             |
| Does `--resume` work a day later?                                     | Give the agent a word to remember, wait 24 hours, then ask for it                                                                                                        | Whether it remembers; if not, what the reply and `err.log` say                               |
| Does a session resume after the harness updates itself between turns? | Between two turns, `claude update` on the host (`claude --version` changes), then send a message. Repeat for Kiro CLI and Codex                                          | Whether it resumes; the host’s card shows the new version after the next connection          |
| Does Kiro CLI limit how long one shell command may run?               | The Kiro agent in **Run everything**: “Use your shell to run exactly: sleep 900; echo done.”                                                                             | Whether, and when, Kiro cuts it off. Postbox mustn’t call it Hung, since a tool call is open |
| How long can a Codex approval wait? 45 minutes passed                 | As 4.2, leave the card for 2 hours, then **Allow**                                                                                                                       | Whether the command runs                                                                     |
| What do Kiro CLI and Codex do when the host’s sign-in runs out?       | Sign the CLI out on the host, then send a message                                                                                                                        | The last lines of `out.jsonl` and `err.log`: they become each adapter’s `signInError`        |
| Does a 24-hour Claude Code turn finish across a sign-in renewal?      | A turn of quiet steps for 24 hours, such as 2.1’s with more steps                                                                                                        | Whether it ends done                                                                         |
| Does a user-scope runner end at the last logout without lingering?    | Section 2.2                                                                                                                                                              | What the log and the reply showed                                                            |
| Does the laptop’s own `permission_prompt` hold a card for 24 hours?   | A Claude Code persona on this computer, as 3.3, left 24 hours                                                                                                            | Whether Allow still runs it                                                                  |

## 6. Last: Remove

**6.1 Remove, with a turn running**
- **Steps:** start the long turn from section 2. While it runs, on the host’s card press **Remove…**, read the confirm, and press **Remove Postbox from host.example.com**. Then, on the host, `ls -a ~ | grep postbox-remote` and `pgrep -u "$USER" -fa '\.postbox-remote'`; here, `ls /tmp/pb-uat-remote/remote-tokens/`.
- **You should see:** the confirm says Postbox stops the daemon and every turn still running, deletes `~/.postbox-remote` there, then forgets the host here, and names the agents placed on it. Then “Removed host.example.com”, “Stopped 1 turn there first.” On the host, both commands print nothing; here, the token file is gone. The personas placed there can’t start a turn until you pick another place for them.
- **If not:** if the host can’t be reached or doesn’t confirm, Postbox keeps the host and its token and says why: that’s correct, and you can try again. If a turn there won’t stop, nothing is removed, and the message names it.

## 7. Clean up

Run this at the end of the pass, and also after a failure or whenever you stop early. Each step puts back something an earlier one changed, and each is safe to run when that earlier step didn’t.
1. **Postbox on the host.** If you stopped before 6.1 and want Postbox gone from the host, do 6.1’s **Remove** now, while the first Postbox still runs: step 2 deletes the token it needs. Then, on the host, this prints nothing:

   ```bash
   pgrep -u "$USER" -fa '\.postbox-remote'
   ```
2. **Both Postbox servers, here.** Press Ctrl-C in each terminal running `server/index.mjs` (ports 4181 and 4182). Then check that nothing listens on them, and delete their data folders:

   ```bash
   lsof -nP -iTCP:4181 -iTCP:4182 -sTCP:LISTEN    # prints nothing
   rm -rf /tmp/pb-uat-remote /tmp/pb-uat-remote-2
   ```
3. **Your ssh agent, here.** With the temporary agent, in the terminal you started it in: `eval "$(ssh-agent -k)"`. If that terminal is gone:

   ```bash
   pkill -f 'ssh-agent -a /tmp/pb-uat-agent.sock'
   rm -f /tmp/pb-uat-agent.sock
   ```

   With your usual agent, compare `ssh-add -l` with what you noted, and add back each key that’s missing: `ssh-add ~/.ssh/id_ed25519` (with each key’s file). If a certificate is still aside from 1.3: `mv ~/.ssh/id_ed25519-cert.pub.uat ~/.ssh/id_ed25519-cert.pub`.
4. **Your known hosts, here.** Restore this run’s backup, check that ssh still connects without asking, then delete that backup only (any other `known_hosts.uat-*` file isn’t this run’s, so leave it):

   ```bash
   test -n "$PB_UAT_KH" && cp "$PB_UAT_KH" ~/.ssh/known_hosts
   ssh -o BatchMode=yes host.example.com true     # exits without asking anything
   rm -f "$PB_UAT_KH"
   ```
5. **Lingering, on the host.** Put back what Before you start printed: if it was `Linger=no`, run `loginctl disable-linger`; if it was `Linger=yes`, run `loginctl enable-linger`. Then check that `loginctl show-user "$USER" -p Linger` prints the same as it did then.
6. **Claude Code’s sign-in, on the host,** if 3.10 or 3.11 stopped with the credentials moved aside. This moves them back unless you’ve signed in again since, and then deletes the moved copy:

   ```bash
   test -f ~/.claude/.credentials.json || mv ~/.claude/.credentials.json.uat ~/.claude/.credentials.json
   rm -f ~/.claude/.credentials.json.uat
   ```

   If you signed Kiro CLI or Codex out for a “Still to confirm” row, sign them in again as you usually do.
7. **The files the steps left, on the host:**

   ```bash
   rm -f ~/pbx-linger.log ~/pbx-codex-uat* /tmp/pbx-*
   ```

**Pass if:** every item above behaves as described, no step leaves a Postbox process running on the host that the item didn’t expect, every “Still to confirm” row has a recorded result or a reason it couldn’t be run, and Clean up has run.
