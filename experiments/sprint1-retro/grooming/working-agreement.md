# Additions to the working agreement (27 October 2026)

Approved by the person after the retrospective of backlog grooming and the first validation round. These join the working agreement in the approved plan. Each names the retrospective item it comes from.

1. **Evidence (A3).** Cite the command that proved a claim, and its exit code. A count of zero or “nothing found” is a finding about the tooling until it’s explained, as AGENTS.md says. A search that errors is retried or reported as failed, never as “nothing found”. A process search leaves out the searching command itself.
2. **Blockers (A3).** Before saying someone is blocking, ask them, or check what they’re waiting on.
3. **UAT runs (A3).** Report a run only after its process has exited. Capture its exit code (for example `node tools/uat-run.mjs …; echo $? > exit`), and quote its figures from the final `report.md`, not one written while it runs.
4. **Order-sensitive fixes (A1).** An issue whose behavior depends on the exact order of events names its deterministic `node:test` test in its acceptance before a paid UAT is planned for it. A real-agent UAT confirms such a fix; it doesn’t decide it.
5. **Writes outside the room (A6).** Every write outside this room, a one-line pointer or a follow-up included, is shown as a draft first, unless the person has said to publish it directly.
6. **Until #484 is fixed (A8).** When a turn’s summary says “earlier items are left out”, read back through the conversation with `read_conversation` before reporting what’s pending or who hasn’t answered.
7. **CI waits (A9, from the retrospective’s revision 4).** Don’t hold a turn open for CI. Post the report as soon as `npm run check` exits 0 locally, say which CI jobs are still running, and leave the CI check to a scheduled wake.

# Additions after round 1 (28 October 2026)

Approved by the person in the round 1 review.

8. **Load (rule 8 of the round plan).** On the person's computer, one full browser run at a time (`with-lock.sh browser`), at most two `npm run check` at once (`with-lock.sh check`), and a full `npm run check` takes the browser lock too, since its process tests start Chromium. Rerun a failure under load once alone, and name it, before calling it flaky.
9. **Who tests what.** Each author owns its own tests, the gate and both browser runs, and code quality, and reports them from the final head. Tester owns the agentic end-to-end tests: UAT runs, and a regression pass on the integration branch. Validation keeps three checks on each branch: a red run of each new test on the final head; a stress run on the person's computer (each new or changed test 10 times, specs also with `POSTBOX_STREAM_LAG=300`); and critic checking that the head and exit codes in each report match what's pushed. The integrator runs the full gate and both browser runs once, on the integration branch.
10. **Definition of done.** An item is done when its PR is open, after critic and tester approve it. Before it's ready for review, every commit has its `Co-Authored-By` trailer and one `Fixes #n` or `Refs #n` line per issue, and the design-doc rows the change affects are updated; critic checks these.
11. **Silence and busy agents.** Before reporting someone as silent, read back through the room and ask them. If an agent is busy, give the work to one in the pool who isn't.
12. **Merge order.** #439 merges first, since until it does a waiting wake card hides messages.
13. **Test-run budget (28 October).** Real-agent test runs (UAT scenarios, the verifier, rechecks) are approved up to $100 in all without asking. Say what a run costs in its report; ask only past that budget.
14. **Each agent owns its own drafts (28 October).** An agent shows its own review blocks and drafts; no agent relays another's. If an agent says it can't use a Postbox tool, it reports the exact call and its error, so the problem can be fixed (#489), rather than handing the work to someone else.
