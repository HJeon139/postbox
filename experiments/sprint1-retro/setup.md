# Setting up a room like sprint 1’s

A checklist for the next scrum master. Each line says what to set and how to check it. The rules it refers to are in `retro/working-agreement-sprint2.md`.

## People and roles

| Role | Who in sprint 1 | Backend | What it does |
|---|---|---|---|
| Product owner and integrator | the person | — | Decides priorities and choices; the only GitHub reviewer and merger |
| Scrum master | researcher | Claude Code | Grooming, estimation rounds, round plans, check-ins, the integration branch, retrospectives |
| Developers | developer, gpt, claude-ssh, kiro-ssh-x86 | Claude Code; Kiro CLI; Claude Code on a remote host; Kiro CLI on a remote host | Build items, one branch and worktree each |
| Adversarial reviewer | critic | Claude Code | Reviews every head, with the checklist in rule 21 |
| Tester | tester | Claude Code | Red, mutation and stress runs on every head; UAT and the regression pass (rule 20) |

**What each role’s instructions need to say.** The personas’ own text isn’t kept here; the person chose to describe the roles instead. Each persona’s instructions should cover:
- **Scrum master:** run the rules in `retro/working-agreement-sprint2.md`; read sources and cite them; show every outside write as a draft; check in on a schedule with a per-PR sweep; keep the glossary.
- **Developer:** read the code, its tests and the design docs before changing anything; write a test that fails first; run the full gate under the locks before any hand-off; report the head, commands and exit codes; one commit per fix, with its trailer and issue line.
- **Adversarial reviewer:** review only; findings as `P1 | file:line | claim`, each with evidence and a fix; the checklist in rule 21; cite the line read.
- **Tester:** the red, mutation and stress runs and the two-way diff in rule 20 on every head; UAT runs reported after they exit, with their cost.

- [ ] Each persona’s role and instructions match its job: developers get developer instructions, not a reviewer’s (theme 4). Check in each agent’s session record.
- [ ] Run `templates/start-of-room.md` for every agent before its first item (rule 11).

## Backends

- [ ] **Claude Code:** each persona keeps its own memory (#208, merged); local `claude` at 2.1.74 or later, which the overview warns about if not.
- [ ] **Kiro CLI:** the agent shows a one-line choice block in its first turn, which proves Postbox’s tools are loaded (#489). If not, start a fresh session before giving it work.
- [ ] Note which agents can’t use Postbox tools, and which agent the person chooses to show their drafts (rule 9).

## Hosts

- [ ] **This computer:** the locks in `grooming/with-lock.sh`: one full browser run at a time, at most two `npm run check` at once, and a full gate takes both (rule 18). Keep it awake while the room runs unattended: a sleep ended agents’ turns and delayed check-ins by hours in sprint 1.
- [ ] **A remote host:** `node` on the non-interactive PATH (sprint 1 used mise), the gate under `umask 022` (#490), and pushed branches plus pasted evidence for every hand-off, since other agents can’t read its files (#417).
- [ ] **A dedicated test host for agentic UAT:** no room agents on it, since a UAT run’s cleanup removes Postbox from the host. Check that `~/.postbox-remote` is absent and no node process runs before a run.

## Worktrees and git

- [ ] One worktree per item and per head under test (themes 9, 2); never share one, and don’t use `git stash` for red runs.
- [ ] `node_modules` linked from a full install; `.gitignore` ignores a link as well as a folder (PR #501).
- [ ] An integration branch, local only, where approved heads are merged and the gate run once.

## Permissions and budget

- [ ] **Outside writes:** drafted for the person first (rule 10); claims and own-branch pushes authorized in the round plan.
- [ ] **Test budget:** real-agent runs pre-approved up to $100 in all (rule 25).
- [ ] **Data:** agents stay out of the person’s Postbox data folder unless the person allows a named, read-only use, as for the E2 and E4 replays.

## Privacy, for a public repo

- [ ] No host names, accounts, local paths, tokens or other rooms’ work in any issue, comment, PR body or published file.
- [ ] No bare `@handle` in GitHub text: put agent handles in code.
- [ ] Before publishing a folder: `git grep` it for host names, accounts, paths, 12-digit ids and keys, and show the person the result.

## Tracking

- [ ] A sprint board and burndown (`grooming/sprint-board.html`, a Postbox app), rebuilt from `figures/` so the numbers can be checked.
- [ ] Check-ins on a schedule, reporting only changes of state (rule 5), with a per-PR sweep of reviewer comments against the owner’s last reply (themes 1, 5).
- [ ] The glossary in the working agreement, extended with `define_term` as terms appear (rule 6).
