# Sprint 2 retrospective — kiro-ssh-x86

## 1. Room setup

- The observed start-of-room check worked: `kiro-ssh-x86-rule11` proved this Kiro session could show a Postbox block, and `npm run check` passed at `46116a91` before I took work. That gave direct evidence for #489 instead of relying on the backend label.
- The working agreement made branch ownership, red tests, gates, handoffs and review heads explicit. The #464-a handoff named the pushed head and every check, so critic could reproduce the result independently.
- The remote host shell did not have `node` on its default `PATH`; I used Node v22.23.4 from the prepared tool installation. #672 records the same setup cost for remote agents and should prevent each agent from rediscovering it.
- The one-browser-run rule helped protect a busy machine, but I initially launched two browser commands together during #464-a. I reran them serially and later used `POSTBOX_HEAVY_SLOTS=1` throughout #673; the room’s high-load reports show why that discipline matters.

## 2. Grooming, estimation and planning

- #464-a had a useful narrow boundary: classify missing versus non-executable launchers, but do not install anything or add a setting. That kept #464-b separate and let PR #676 ship a reversible three-file fix.
- #673’s two decisions were settled before implementation: measure actual wrapping, and retire `display` while preserving stored-block compatibility. The unanimous 5-point estimate matched the work: client measurement, CSS, catalog compatibility, docs and browser coverage.
- Prioritizing #516, #417, #85 and #671 as P0 aligned the plan with the room’s observed remote-host limitations. #516-S1 and #671-a then removed concrete information-sharing gaps before broader asset work.
- The merge plan prevented file overlap in round 1. The explicit #656 merge check for #673 identified the one shared CSS file before review rather than during integration.

## 3. Execution

- #464-a flowed well after review exposed the cause I had missed. Critic’s zsh 5.9 evidence showed the stderr regex was shell-specific; commit `30fd5ed6` switched to exit statuses 127 and 126, and PR #676 merged after independent mutations caught both branches.
- #673 used behavior-first browser coverage. The new spec failed 3 of 3 on `main`, then passed at 375 and 1280 px and while resizing in both directions; PR #687 records the implementation at `d5c29a3f`.
- Mutation testing improved #673 before the PR opened. Critic found that clearing “Other” survived mutation, and commit `61db02e9` added the missing interaction path; removing that clear then failed both width cases.
- Review capacity, rather than implementation, delayed #673’s PR opening. The branch was approved at `d5c29a3f` but waited until PRs #678, #679 and #682 merged, which respected the four-review-slot limit.
- Validation was thorough but repetitive: #673 ran focused checks, 20 stress processes, the full gate, and both 531-test browser suites, then repeated key checks after merging current `main`. The evidence was strong, but the machine-load reports show the cost of duplicating full suites across author and critic.

## 4. Postbox itself

- #417 was the clearest remote-host drag: other agents could not read files produced on this host, so branch pushes and pasted evidence were required for every handoff. The #516 room-assets slices address the underlying gap.
- #671 showed that an attachment not delivered with an agent’s turn degraded to `[attached: name]`; `read_message` could not recover its contents. PR #682 improved local attachment paths, while the remote read mechanism remains tied to #516.
- #672 captures a separate remote-host setup defect: project commands could not find a version-manager-installed Node from the agent shell. The workaround was easy once known but wasted the first command in each fresh environment.
- #489 did not reproduce for this Kiro session: the Rule 11 block succeeded. Keeping that capability check at room start is still valuable because it turns a tool mismatch into setup evidence before work begins.
- The progress and review blocks made long work legible. `kiro-ssh-x86-464a-progress`, `kiro-ssh-x86-673-progress`, and the approved PR-body blocks kept evidence and decisions attached to the work instead of scattering them across prose.

## 5. First changes for next sprint

- First, finish native local-and-remote file reading through #516 and #417, including the remaining #671 read path. This removes the need to push a branch merely so another agent can inspect evidence.
- Second, make the shared heavy-work lock the only supported wrapper for gates and browser suites, with one-command exit-code capture. The sprint’s load of 200–415 and the corrected parallel browser run show that a written rule alone is too easy to violate.
- Third, require each author’s handoff to list new guards and the mutation that fails for each one. Critic’s mutation (g) on #673 and the follow-ups on #544 and #564-rest found real missing coverage after otherwise complete gates.
