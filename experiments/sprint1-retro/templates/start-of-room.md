# Start-of-room check (rule 11)

Run before any agent gets its first item, and again after any role change or new session.

For each agent, the scrum master records:

| Agent | Backend, model | Host | Role in its session record matches its assignment | Showed a one-line choice block | `npm run check` on its host, exit code | Notes |
|---|---|---|---|---|---|---|
| <handle> | <backend>, <model> | this computer / <host label> | yes / no (fresh session if no) | yes / no (#489 if no) | 0 / … | |

- **The role:** read it from the agent’s own session record (for example the Kiro session’s `session_start` prompt), not from what the agent says.
- **The tools:** the agent must actually show the block. Saying a tool is missing, without a failed call, doesn’t count.
- **A remote host:** `node` on its non-interactive PATH, its umask (022 for the gate, #490), and the harness binaries the room uses.
- **Rules:** the working agreement, commit format and trailers are posted and acknowledged before any branch (rule 12).
