# Work room: real changes, the agents in the sidebar, and the right pane

- persona: A developer who wants a small tool built and reviewed, and checks what the agents actually did rather than what they say they did. Practical, writes short messages, and changes an agent’s settings without leaving the conversation.
- agents: researcher, critic
- place: researcher=host1, critic=host1
- project: Unit converter
- conversation: Unit converter CLI

@researcher builds and changes real files in this folder, and @critic reviews them. Use the Agents section in the sidebar to see and change each agent, and the right pane to follow the work. Check that what the Work view shows comes from what happened (files, commands, commits), not from what an agent says it did. Notice anything you had to type a command for, anything you couldn’t reach by keyboard, and anything in the right pane that lost your place.

## Phase 1: Build it, and follow the work

- host: researcher

Ask @researcher to set up a tiny Python command-line unit converter in this folder as a git repository: one module, a test file with a few tests, run the tests, and commit. While it works, open the Work pane: its compact view should show the files, the commands with their exit codes and the spend, without opening anything. Then open Work full screen: each file should have its diff, and each command its output. Compare it with what @researcher says it did, and report any difference. Close full screen with Escape.

### On a host

@researcher and @critic both work on another machine in this run, in the project’s folder there. Ask @researcher to set up a tiny Python command-line unit converter in that folder as a git repository: one module, a test file with a few tests, run the tests, and commit. While it works, open the Work pane: it should show the commands with their exit codes and the spend, and each file it changed as a step on the host, saying Postbox keeps no copy of it, rather than a diff. Then open Work full screen: each command should have its output. Compare it with what @researcher says it did, and report any difference. Close full screen with Escape.

## Phase 2: Change an agent from the sidebar

Bring @critic in to review the code. In the Agents section, open @critic’s quick panel. Set its effort to low, and turn Shell off: the panel should say Shell is set for @critic everywhere, and effort only in this conversation. Ask @critic to run the tests. The command should be refused with a visible reason, and @critic should say its shell is off, not that the tests passed or that you declined. Turn Shell back on from the panel, ask again, and check the tests run.

## Phase 3: A topic thread beside the Work pane

- host: researcher

Start a topic thread on @researcher’s commit message, and ask @critic there to suggest one change. With the thread open, open the Work pane too: the two should share the right side, one above the other. Open the thread full screen, type a reply without sending it, and leave full screen: your draft should still be there. Send it. Ask @researcher to make the change. Then, in Work, restore one file @researcher changed, and confirm. The agents should hear that you restored it. Finally, use the work line under @researcher’s last reply: it should open Work at that turn.

### On a host

Start a topic thread on @researcher’s commit message, and ask @critic there to suggest one change. With the thread open, open the Work pane too: the two should share the right side, one above the other. Open the thread full screen, type a reply without sending it, and leave full screen: your draft should still be there. Send it. Ask @researcher to make the change. Then, in Work, try to restore one file @researcher changed: on a host, Postbox has no copy of it, so it should say it can’t restore it and why, not fail silently. Finally, use the work line under @researcher’s last reply: it should open Work at that turn.
