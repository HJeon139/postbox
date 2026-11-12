# Running agents on a remote host

Setting up a host, what you see while agents work there, and the settings worth knowing.

## Run agents on a remote host

An agent’s turns can run on another computer you reach with `ssh`, such as a build machine or a cloud desktop, while Postbox stays on this one (#120). Only the agent’s process moves. The conversation, its cards, the store and Postbox’s API stay here, and Postbox drives the host over an `ssh` it starts itself. Nothing on the host reaches back: no port is opened or forwarded on either machine, and nothing there gets a route to Postbox on this computer. Claude Code, Kiro CLI and Codex can run on a host; the Agent SDK and the Antigravity CLI can’t. The design is in [designs/architecture.md](architecture.md), “Remote hosts”.

**What the host needs**
- **Linux.** Postbox relies on `/proc`, the boot ID and, where logind ends processes at logout, systemd.
- **`ssh` from this computer with no prompt.** Postbox runs your own `ssh` with `BatchMode=yes`, which turns off password and host-key prompts ([ssh_config(5)](https://man.openbsd.org/ssh_config)), so it fails rather than wait. That means a key in your ssh agent or a valid certificate, and the host’s key already in your known hosts. Your `~/.ssh/config` still applies: aliases, `ProxyJump`, certificates and the user. To check, run `ssh -o BatchMode=yes host.example.com true` in a terminal: if it exits without asking anything, Postbox can connect.
- **Node 22 or later there.** Postbox looks on `PATH`, then under `~/.nvm`, `~/.local/share/mise` and `~/.volta`, then in `/usr/local/bin` and `/usr/bin`. For one anywhere else, set **Node’s path** in the host’s settings.
- **The harness, installed and signed in on the host** as your user: `claude` (2.1.187 or later, or 2.1.259 or later with denyPrompts on), `kiro-cli` or `codex`. Postbox looks on `PATH` and in the folders their installers use, such as `~/.local/bin`, and says where it looked when it finds none. Postbox never copies a credential to the host.
- **An ordinary user.** The daemon refuses to run as root.

**Set it up**
1. **Settings → Hosts → Add a host.** Type the SSH destination as you would after `ssh`: an alias from `~/.ssh/config`, a host name, or `user@host.example.com`.
2. **Install…** The confirm says what it writes outside Postbox’s folder, on both computers, and shows the commands `ssh` runs there:
   - Postbox’s host program (`server/remote/host/` and the `shared/` modules it imports) in `~/.postbox-remote/<version>/` on the host, readable only by you (folders `0700`, files `0600`, and the launcher `0700`), each checked against a SHA-256 manifest that comes in the same archive: that catches a broken copy, not a tampered one.
   - The daemon’s token in `~/.postbox-remote/token` there (`0600`), and a copy on this computer in `data/remote-tokens/<host id>` (`0600`), outside what the page reads.
   - With **Node’s path** set, a `node-path` file beside the code that names it.

   Nothing runs as root, and nothing outside `~/.postbox-remote` changes on the host. Postbox connects when a turn there needs it. From then on, the host’s card lists the Node and the harnesses its daemon found, each with its version and path, or where it looked.
3. **Edit settings → Project folders on this host.** Where each project’s agents work there: an absolute path. Left empty, an agent works in `~/postbox-work/<handle>` on the host.
4. **Runs on.** In a persona’s settings, or the new-agent sheet, pick the host under **Runs on**. Its agents run there from their next turn. Postbox refuses a host whose daemon didn’t find that persona’s CLI, and an agent can’t move while a turn of its runs.

**What you see**
- **Where it runs.** The agent’s row and its ring say where it runs and how the connection stands, such as “On host.example.com · Connected · last heard from 2 min ago”. The connection is Connected, Reconnecting, Disconnected (working) when a turn runs there while Postbox can’t reach it, or Disconnected (idle). A dead connection is dropped after about 45 seconds of missed keepalives. Postbox reconnects with backoff while a turn runs there or a prompt waits, and as soon as this computer wakes. The turn goes on on the host meanwhile, and what it wrote arrives on reconnect, each line once.
- **Permission cards** work as they do here. A prompt waits on the host, even while this computer sleeps, for up to the host’s permissionWaitMax, then it’s denied and the card says it expired.
- **Sign-in needed on host.example.com:** the harness’s sign-in on the host ran out (Postbox recognizes Claude Code’s). Sign in there, then press **Resume**. With a signInCheck set, Postbox resumes on its own once the check passes, and warns before a turn when it fails.
- **Interrupted on host.example.com:** the agent’s process there ended without finishing its turn, such as after a reboot. Postbox resumes on its own once the host is back, up to three times in a row, then waits for **Resume**. A resumed Claude Code turn continues the turn that was cut off, and every resumed turn starts with a line telling the agent why.
- **Hung:** “Stopped: no output for 15 min (the last at 14:02)”. A turn with no output for the host’s stallTimeout, no card open and, for Kiro, no tool call open, is stopped. Time while Postbox can’t reach the host doesn’t count.
- **Lost: Postbox can’t reach host.example.com, and the turn may still run there.** Postbox gave up reconnecting during a turn. It attaches to the turn again once the host is back.
- **Stop** goes through the host’s daemon, and the agent reads “Stopping on host.example.com” until the host confirms it. A remote turn’s Stop is always a plain stop: its background jobs stop with it, and when it has any, Stop says so before you press it.
- **A Postbox restart** doesn’t stop a remote turn. The new Postbox finds it running and replays it from the start, replacing the partial reply.
- **The Work view** records the commands, commits, pushes and effort a remote turn’s stream shows. Files on a host aren’t recorded, and it says so.
- **`!` commands** run on this computer, not the host, and their output says so.
- **Kiro CLI** takes its message as a command-line argument, so each remote Kiro turn shows a step saying other users on the host can read it, and a message over 128 KiB is refused before the turn starts.

**The settings worth knowing.** Each host’s **Edit settings** has the full list, with ranges.

| Setting | Default | What it does |
|---|---|---|
| stallTimeout (“Stop a quiet turn after”) | 15 min | How long a turn may go with no output before it’s stopped as hung. Raise it when tools or models stay quiet for longer |
| permissionWaitMax (“Longest wait for a permission answer”) | 24 h | How long a prompt waits on the host before it’s denied |
| denyPrompts | Off | On, Claude Code denies what it would ask about (`--permission-prompts none`) instead of waiting on a card, for unattended runs |
| signInCheck | None | A command that exits 0 while the host’s sign-in is good, one argument per line, run without a shell: such as `klist` and `-s`. With one, a turn stopped for its sign-in resumes once it passes; without one, the turn waits for you |
| idleTimeout (“Daemon’s idle time”) | 30 min | The daemon on the host exits after this long with no turn running and no Postbox connected. Postbox closes its own connection 2 minutes after nothing needs it |
| How turns detach | Own session, and a user scope | “Own session only” for a host without systemd |
| forwardAgent (“Forward your ssh agent”) | Off | Lets turns sign in to other machines with the keys in this computer’s ssh agent |

**Forwarding your ssh agent** doesn’t copy your private keys to the host. But while Postbox is connected, any process running as your user there, including the agent and the commands it runs, can use this computer’s ssh agent to sign in to other machines. So turn it on only for a host you trust that needs it. [ssh_config(5)](https://man.openbsd.org/ssh_config) says the same under ForwardAgent: “Agent forwarding should be enabled with caution. Users with the ability to bypass file permissions on the remote host (for the agent’s Unix-domain socket) can access the local agent through the forwarded connection. An attacker cannot obtain key material from the agent, however they can perform operations on the keys that enable them to authenticate using the identities loaded into the agent.” With **Use a connection of its own** off, Postbox’s session rides your existing shared connection. Agent forwarding still follows this setting for Postbox’s session, but any port forwards that connection opened stay open, and its host key was checked as you opened it.

**Lingering, on systemd hosts.** Where logind kills a user’s processes at logout (`KillUserProcesses`, which “defaults to yes”, per [logind.conf(5)](https://www.freedesktop.org/software/systemd/man/latest/logind.conf.html)), each turn also goes into a systemd user scope, and without lingering that scope ends at your last logout from the host. Postbox’s own connection is one of your sessions while it’s open. When lingering is off there, the host’s card warns, from the first connection, “Turns on host.example.com end when your last session there does” and gives the command, `loginctl enable-linger`, run on the host. Lingering keeps your user manager “around after logouts”, and with no argument it’s for the user who runs it ([loginctl(1)](https://www.freedesktop.org/software/systemd/man/latest/loginctl.html)).

**Remove.** On the host’s card, **Remove…**, then **Remove Postbox from host.example.com**. Postbox stops every turn still running there, has the daemon delete `~/.postbox-remote` on the host (its code, token, logs and turn records), and only then forgets the host here: its settings, its project folders and its token. If the host can’t be reached, doesn’t confirm, or a turn there won’t stop, nothing is forgotten and you can try again. Agents placed on it can’t start a turn until you pick another place for them. Each harness’s own sessions and sign-in on the host stay.
