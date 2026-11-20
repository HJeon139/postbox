# The ATIF exporter’s real UAT run: `uat-askquestion/`

`events.jsonl` and `live.jsonl` are what `node tools/uat-run.mjs --scenario askquestion --max-cost 5 --budget 2 --verify no` kept of its Postbox server’s `/api/stream` (`tools/uat/history.mjs`, `writeHistory`), run on 20 November 2026 at commit 933d9884 of #1522. Nothing in them was edited.

The agent, `@researcher`, was a real Claude Code agent on claude-haiku-5-5; the tester played the person through `tests/uat/e2e/scenarios/askquestion.md`: two AskUserQuestion calls, three questions answered as blocks. It has no run clock. Harbor’s validator (harbor-framework/harbor at 2ea52267, `src/harbor/utils/trajectory_validator.py`) passed its export.
