# Blind retrospective, sprint 4: lead-security

Written before reading any other sprint 4 retrospective. Times are UTC.

## 1. Room setup

- **The shared gate script, its lock and load bar, worked.** Gates queued and ran one at a time without my watching them. The light gate on #1201's last fix queued at 15:15, took the lock at a load of 1.2, and finished both Nodes by 15:17 (commit `af31ebff`, cited in #1201's body).
- **Subagents die with the session and leave half-done work.** It happened on #1146 twice and on #362. Then at about 17:00 all four subagents I'd started for the integrator's change requests died on the 403. They left one uncommitted test or fix each in the worktrees of #1169, #1188 and #1190 (local state at close).
- **One shared GitHub identity hides who pushed what.** After the pause, fixes for #1184, #1188 and #1190 landed on my branches at about 17:45–17:50, under the same author name I use. Only comparing heads stopped me from pushing over them (my close message; `24b1a81a`, `f4c63e2c`, `4fbaf5ea`).
- **zsh doesn't split words, and it bit me twice in one hour.** A string holding a list of test files made a mutant run print nothing, and `$R` broke `gh pr create`. Both were caught before they misled anyone, and #1201's body records the first.
- **@mentions inside `wake_agent` don't wake anyone.** That cost about 3.5 hours of silence on #1122's follow-ups (21:45–01:12 on 9–10 Nov), until scrum-master found the cause. Scheduling my own wake after each push fixed it for the rest of the sprint.

## 2. Grooming, estimation and planning

- **Taking #817 first, as P0, was right.** It merged on the first day as #865, and the follow-ups (#871, #920, #806) merged as #917, #936 and #1021.
- **Bundling worked for small issues:** all 11 bundle issues (#820/#804, #784, #785, #660, #661, #696, #646, #704, #665, #547) are closed.
- **The generic allow list never became a PR of mine.** Whatever split grooming had in mind for it, `harness first` (#961) merged instead, and I have no evidence that the allow list was ever re-scoped. It needs an explicit decision in sprint 5 grooming.
- **Handing over #1125's remainder whole, with "probe each item on `main` first", sized the work honestly.** All four items reproduced with fake secrets before any code (#1125 issuecomment-6770652691), and the review found a fifth (#1201's URL-scoped helper).
- **The pause on new PRs left gated work idle for hours.** #1199, #1200 and #1201 sat as pushed branches from about 14:10 until about 16:25, when the person chose to keep building.

## 3. Execution

- **The integrator requested changes on 4 of my 5 PRs that critic had passed.** Every cause was something my tests couldn't see:
  - **#1188:** macOS's `tmpdir()` isn't `/private/tmp`, so every real output file was refused.
  - **#1190:** Linux's single-argument limit was applied on every platform.
  - **#1169:** one failed agent's hold blocked a message to several agents.
  - **#1184:** a narrower pattern revealed keys starting with a digit that `main` hid.

  #1188's and #1190's bodies said "Server only, so no Mac check".
- **Critic's reads caught real defects:** a cross-thread re-hold in #1146 (#1169), and the URL-scoped credential helper in #1201. Once, critic's suggested fix was wrong: `--get-urlmatch` would have stopped every guarded run. A probe with a fake helper showed it before I built anything (my reply to critic on #1201).
- **Gate failures were cheap and caught before every push:** Biome formatting, the privacy-tree check on a literal temp path, the 50-line `describe` cap, and file line caps (#1188, #1190, #1200, #1201 bodies).
- **Merges waited longest.** No PR merged between 09:40 and 16:58, while labeled PRs piled up to 19 (scrum-master's 15:46 stand-up).
- **One-deep stacking was smooth:** #1201 on #1200 has no checks until it targets `main`, as the working agreement expects.

## 4. Postbox itself

- **Postbox ran out of memory twice under the full room** (#1210, #1213). One restart dropped a half-written event, which the person confirmed seeing in their terminal.
- **Agent turns that end with the host process leave subagents orphaned.** Nothing tells the lead which subagent finished what. I had to rebuild each one's state from `git status`.
- **During the 403 period, failed turns kept posting the same error** from many agents, with no back-off or grouping (room messages from about 17:00 to 17:30).
- **Long catch-ups cut items at 2,000 characters.** The `read_message` pointer made that workable.

## 5. For the next sprint, in order

1. **Ask for a Mac check on any change touching paths, temp folders, environment variables or OS limits,** server-only included, and say in the PR body which platforms actually ran. This alone would have caught #1188 and #1190.
2. **Before a PR goes to critic, test where the change reaches beyond its own case:** a message to several agents for any rule about one agent (#1169), and a diff of redaction output against `main`'s over a set of forms (#1184).
3. **Make work survive a dead session:**
   - a subagent commits a WIP commit after each step, so its work can be recovered;
   - every resume starts by fetching and comparing each branch with GitHub, since the identity is shared;
   - run fewer agents at once, to stay clear of the usage block that paused this sprint.
