# Prompt: wave 4, agent activity (#73, #129’s rest)

A wave 4 session, integrated by the reviewing session. Follow [README.md](README.md) for the rules every session shares. Your ports are 4800–4849 for servers and 10100–10149 for Chrome.

---

You’re showing what an agent’s subagents and background tools are doing, on the branch `feat/w4-agent-activity`, in one pull request with one commit per issue.

## Why

Directing agents means knowing what each is doing and when to step in. Two kinds of work still happen out of sight:
- **#73, subagents:**
  - **Narration dropped:** the stream mapper drops a subagent’s own narration (`subagentEvent` in `server/adapters/claude-stream.mjs`).
  - **Thinking cut short:** it keeps only the first sentence of its thinking.
  - **The evidence:**
    - In the HotpotQA UAT (21 October 2026), the @critic subagent rewrote the pipeline, and said so as it started, but the person saw only an idle screen.
    - Over that run, 463 of 463 samples taken while a subagent worked looked idle.
- **#129’s rest, background tools:** #126 tracked `Bash` with `run_in_background`, but Claude Code’s `Monitor` tool also returns at once and keeps running. Its step reads “done” while it runs (the P0 UAT’s `background-step-closed`, in `uat-runs/2026-10-23T04-30-34-p0` and `…T05-26-58-p0`). After Keep running, an agent also closed its own progress step as failed while the kept loop was still writing.

## Scope, from #73’s scope check

- **Build:** elements 1–3 and 7: a subagent’s narration, its summarized thinking, the subagent tree, and a line that’s visible without hover.
- **Element 4 (Running now):** only if a recorded stream shows background subagents disappearing when the reply ends. Otherwise, drop it.
- **Element 5:** Stop for one subagent only if the CLI or the SDK exposes it.
- **Element 6:** a TodoWrite checklist only after 1–3, and only if the recorded runs show TodoWrite.

## Read first

- [README.md](README.md); `designs/intent.md` (the Agents section and agent-tree rows, and principle 5); `designs/architecture.md` on the stream mapper.
- #73 and #129 with their comments, and the recorded streams under `tests/fixtures/claude-code/`.
- #171’s agent tree in `app/js/agents.mjs`, and the background-job code (`ctx.job`, `recordJob`) in `server/runtime.mjs`.

## The work

- **#73:**
  - Keep a subagent’s narration and its thinking in the stream mapper, from recorded fixtures (record new ones if needed, and say where they came from).
  - Show them in #171’s agent tree as children of the agent that started them, with what each was asked and what it’s doing now, one line each, without hover.
  - **Don’t build a second tree.**
- **#129:**
  - Treat any tool that returns a background id (`Monitor`, and any others the fixtures show) as a job, with the same tracking, Stop and Keep running as Bash jobs.
  - A step after a kept job reads as running on, not failed.

## Files

- **Yours:**
  - `server/adapters/claude-stream.mjs` and its tests;
  - the job code in `server/runtime.mjs` (`recordJob`, `endJob`, `settleJobs`);
  - the subagent parts of `app/js/agents.mjs` and `app/js/thread.mjs`’s activity rows;
  - `tools/check-agents.mjs`.
- **Shared:**
  - **`app/js/agents.mjs`:** the side-threads session changes the side-thread entries. Add subagents as children in that structure, and expect to rebase on them.
  - **The Work ledger (`server/ledger.mjs`):** it reads job events, so keep their shape (`ctx.job({ kept, groups })`, `state`).

## Done when

- Tests built from recorded streams show narration and thinking kept, and a `Monitor` step reads running until it ends.
- A headless check shows a subagent’s line in the tree while it works, clean with `--lag 300`.
- Element 4’s reproduction is recorded in the pull request, whichever way it came out.
