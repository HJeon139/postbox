# Blind retrospective, sprint 4: researcher

Written before reading any other agent’s sprint 4 close retrospective. My role this sprint was Mac checks in Chromium and Firefox, timed reference samples for the budget spec, profiles and traces, and counts from the room’s record. Every bullet names its evidence.

## 1. Room setup: roles, backends, hosts, tools and the working agreement

- **Helped: one agent on the person’s Mac for browser checks.** Leads on Linux hosts sent me Mac checks with a head, a spec list and the counts they wanted back. That shape made results easy to compare and answer: #1175 (it_ipGds9tZ), #1198 and #1202 (it_Q3sML0cz).
- **Got in the way: the claim rule for the Mac didn’t prevent collisions.** Tester’s claim reached me after I had started a timed run, so tester’s #1159 check overlapped my whole #1185 sample and I had to mark it loaded (it_bJWxSjwv, it_Qq2RHXRC). A claim posted in chat is only as fast as delivery, so it can’t be a lock.
- **Got in the way: the backend failed under every Claude Code agent at once.** My replies failed with a 403 from the model provider, as did most leads’ (it_YFUsjSWU, it_3ugcbEPI). A Mac check owed for #1175 waited on it, and the team paused (it_5sb07h9a).
- **Helped: the rule that agents never touch the person’s Postbox data folder.** When lead-state asked me to run its log checker on that folder, I asked the person first with a confirm, and lead-state agreed the request should have said so (it_XAU4bE2W, it_Y6S2kD1r).
- **Got in the way: the request for one check changed between two messages.** Lead-host-install’s first #1175 request named `remote-stop` plus the persona and agents specs; the second named `remote-stop` and `remote-ui` only (it_9hvIHsEe, it_7uoU3qZA). I ran the second and said what I left out (it_ipGds9tZ).

## 2. Backlog grooming, estimation and planning

- **Worked: counts from the record fed planning.** My sprint 4 numbers gave the before and after for harness first, about 6–19 permission cards an hour then 0 in about 20 hours, and the 7.5-hour held wake (as_7sVT0LtP).
- **Worked: measurement changed what was planned.** The element count showed folded tool steps at 68% of a 5,000-item room’s elements, which became #1028 and #1034 ahead of the transcript window (as_SpRm7fh4).
- **Would change: the budget spec’s pass bar moved while samples were being taken.** I took reference samples on four heads of #1185 (`c9ba0f05`, `ed8edcb5`, `5aaf946c`, `bd0a3623`), and one was out of date before it ran because key pacing changed (it_m69Io6TR, as_LOgNeoqu). Agreeing the measurement method before planning the samples would have saved two of them.
- **Would change: Mac time wasn’t planned as a resource.** Tester and I both queued Mac work from many leads, with no slot plan, so timed and untimed runs were sorted out message by message (it_NsyYB5Pv, it_LdLkD582, it_bJWxSjwv).

## 3. Execution: building, review, validation, integration

- **Flowed: two-browser checks that came back with exit codes and counts.** #1175 at `1f6e2e3f` passed 30 of 30 in each browser (it_ipGds9tZ); #1198 at `d323197c` passed 48 of 48 in each; #1202 at `c277a329` passed `demo-a11y` 4 of 4 in each, where `main` failed 3 of 4 in Firefox (it_Q3sML0cz).
- **Flowed: a check that found more than it was asked.** #1191’s fix removed its Firefox error, but `demo-a11y` still failed 3 of 4 in Firefox, from two Firefox-only failures that had been hidden on `main` (it_GxJv72QQ). Those became #1196 and #1197, which #1202 fixes.
- **Waited: checks went stale when heads moved.** #1175 moved to `7f443c79` after my pass on `1f6e2e3f`, and #1185 is now at `4f62dbfa`, past every reference sample I took (pr-check.json, `gh pr view`, exit 0). A check names its head, but nothing tells the checker when it stops covering the PR.
- **Waited: I corrected my own profile reading.** I first told lead-measure that Playwright’s queries caused Firefox’s 455 ms task while typing, then matched frame ticks to keydowns and found it was Firefox’s cycle collector, inside the timed window (it_mjT2B14t, it_z7dZbhRt, it_VDbZIeLu).
- **Waited: one check could no longer answer its question.** By the time the person approved the read-only log check for #1210, a restart had taken a new snapshot, so the log from before the crash was gone (it_PJOOepO7).

## 4. Postbox itself

- **The crash and memory growth:** Postbox ran out of memory after about 11 hours, dying in a whole-state `JSON.stringify` (#1210). Its restart folded the log into a new snapshot, which removed the evidence a crash check needed (it_PJOOepO7).
- **Delivery delay between agents:** a claim and a “done” arrive late enough that two timed runs can overlap (it_bJWxSjwv). This is the room-level cause behind the collisions in section 1.
- **An unknown model name was accepted silently:** the persona setting took a model name Kiro doesn’t list, with no warning (scrum-master’s report earlier in this room). I didn’t test it myself.
- **Large reads:** `read_conversation` returns pages too large for a turn, so finding my own earlier results for this close meant saving pages and searching them. A filter by author would have answered it in one call (this turn’s reads).

## 5. For the next sprint, in order

1. **One scheduler for the Mac, not chat claims.** Postbox, or one script both checkers call, takes a lock before a timed run and releases it after, so a late message can’t cause an overlap (it_bJWxSjwv, it_Qq2RHXRC).
2. **A Mac check states the head it covers, and the PR shows when that head moves.** Then a lead re-requests the check without a reader having to compare hashes (#1175 `1f6e2e3f` to `7f443c79`).
3. **Fix the method before taking budget samples.** Settle #1185’s pacing and pass rules first, then take one clean reference sample per browser on that head (as_LOgNeoqu, it_m69Io6TR).
