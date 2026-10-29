# claude-ssh (posted in the room as it_vCpmoZLs, 18:03:37 UTC 29 Oct)

**1. Room setup**
- **What helped:** a separate worktree for each PR (`wt-208`, `wt-485g`, `wt-polish`). It let #496 and #536 move at the same time without stepping on each other.
- **What helped:** having critic and tester as separate reviewers. On #536, tester’s mutation of `2acecf0` found a check that no test caught, and that became `451cb63`. Critic found a second-Retry double wake in `47aa466`, which became `a05c74b`.
- **In the way: the remote host.** I couldn’t reach the person’s Postbox settings or gpt’s Kiro sessions, so the person had to apply the kiro-ssh-x86 persona fix themselves (`kiro-x86-persona`). The check of gpt’s sessions also had to go to researcher.
- **In the way: environment setup, early on.**
  - Node wasn’t on PATH, which I fixed with mise.
  - The host’s umask 077 made a test fail, filed as #490. Every gate since has run under umask 022.
- **In the way: wake cards held my hand-offs.** My mentions of critic and tester “woke no one” twice on #536, while a card waited for the person, so I had to send them again.

**2. Grooming and planning**
- **Worked:** settling scope with choice blocks before building. Examples: `208-delete-scope` for #208’s delete, and `485-failed-mentions` for #485’s wakes.
- **Worked:** labeling #485 “Refs” rather than “Fixes” once its cause wasn’t confirmed. The HotpotQA UAT, 18 streams, didn’t reproduce it, so the PR was scoped as guards (#536’s body).
- **Would change:** that UAT and the fixture scans took a long turn and still didn’t reproduce #485. A time box with a fallback (“guard it, and keep diagnostics”) agreed up front would have saved that turn.
- **Not seen from my side:** the planning-poker numbers. I can’t judge estimation.

**3. Execution**
- **Flowed:** tests first, then red runs, then stress runs. Every #536 fix had a test that failed first: `d8a56e7` on `451cb63`, and `e5f1a10` on `47aa466`.
- **Waited: the integrator found what critic and I missed.**
  - #496’s purge crash, fixed in `f4e7e67`.
  - On #536, `/compact` ending as a failed reply, and Retry waking twice.

  Each cost a full review round.
- **Waited: merge conflicts on shared files.** On #536 these were `claude-stream.mjs` and `designs/intent.md`, which needed merges `b944250` and `dfee586`. In one case the person and I merged the same thing (`5145312`, and my identical `1385174`, which I dropped).
- **Waited: line ceilings forced extra changes.**
  - The refactor `7a22845`.
  - The test-file split `0c1f626`.
  - The Agent SDK raw tail, which I left undone.

  These were the right calls, but each found at gate time.
- **My own slips:**
  - I committed a `node_modules` link to the polish branch, and critic caught it. I caught a second one on #485 before pushing.
  - Commit headers went over 100 characters (`6f8b557`).
  - `5956c93` bundled four fixes into one commit.

**4. Postbox itself**
- **Wake cards blocking unrelated hand-offs:** my #536 hand-offs were refused while a card waited (#439, #526).
- **A reply posted with no text, and a failed reply hidden from other agents:** #485, the cause of my main sprint work.
- **One report sent once per recipient:** `wake_agent` duplicates (#481, with kiro-ssh-x86’s numbers in my comment there).
- **A Kiro session started with no Postbox tools:** #489. It’s why gpt couldn’t show review blocks, so researcher had to relay its drafts.

**5. The next sprint, in order**
1. **Before approving, reviewers check today’s `main` merged in and the edge paths:** slash or attach turns, Retry, restart, and two tabs. That’s what the integrator found and we didn’t, on #496, #513 and #536.
2. **Owners merge `main` and run `biome check` before each hand-off,** so conflicts and line ceilings surface early, not at gate time.
3. **Fix or work around wake cards holding hand-offs** (#526). Until then, an agent whose mention “woke no one” resends it as soon as the card is answered.
