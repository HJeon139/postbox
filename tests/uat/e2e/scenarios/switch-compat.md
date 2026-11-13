# Switch an agent across every backend and back: each switch takes effect

- persona: Someone who tries one agent on every harness they have, to compare them. Writes short messages.
- agents: researcher
- permission_modes: researcher=auto
- project: Switching
- conversation: Which harness is it

The compatibility run of [switch](switch.md) (#1315): one agent, @researcher, starts on Claude Code and is switched through its persona sheet to the Agent SDK, Codex, back to Claude Code by its backend alone, the Kiro CLI, the Antigravity CLI, and back to Claude Code. After each switch it takes a turn, and the run checks from what it recorded that the turn ran on the chosen backend (its stream is in `streams/`, `streams/sdk/`, `streams/codex/`, `streams/kiro/` or `streams/agy/`), that the backend reported the chosen model and effort where it reports them, and that the agent’s row names them. Kiro reports no model on its router (`auto`), so its turn shows only which backend ran it. This is where an agent was seen stuck showing “Opus, not auto”. Watch for a row that names the model of the backend before the switch, a sheet that kept a model the new backend doesn’t run, and a turn that fails after a switch.

`node tools/uat-run.mjs --scenario switch-compat --compat --budget 2 --max-cost 8 --file no`

Each phase is one switch. Use `agent_panel` on @researcher with exactly what it names: the model is typed into the Model field as written. Don’t change anything else.

## Phase 1: Agent SDK, Sonnet, low effort

- triggers: ran-sdk-sonnet-low, shown-sdk-sonnet-low
- steps: 4

With `agent_panel`, set @researcher to backend “Agent SDK”, model `claude-sonnet-5-5` and effort `low`. Then send “@researcher, reply with the single word ok.” Once it has answered, read @researcher’s row in the Agents section, and say whether it names Sonnet 5.5 and low effort, with no “not” or “set to”.

## Phase 2: Codex, its default model, high effort

- triggers: ran-codex-auto-high, shown-codex-auto-high
- steps: 4

With `agent_panel`, set @researcher to backend “Codex”, model `auto` and effort `high`. `auto` is Codex’s default: the model your Codex configuration picks. Then send “@researcher, reply with the single word ok.” Once it has answered, read @researcher’s row in the Agents section, and say whether it names Codex’s default and high effort, with no “not” or “set to”.

## Phase 3: Back to Claude Code, the backend alone

- triggers: ran-cc-backend-only, shown-cc-backend-only
- steps: 4

With `agent_panel`, set only @researcher’s backend, to “Claude Code”: give no model and no effort. The sheet should put a Claude model in place of Codex’s `auto` by itself. Say what model and effort it saved. Then send “@researcher, reply with the single word ok.” Once it has answered, read @researcher’s row in the Agents section, and say whether it names a Claude model (Opus 5.5) and the effort the sheet saved, with no “not” or “set to”.

## Phase 4: Kiro, its router, high effort

- triggers: ran-kiro-auto-high, shown-kiro-auto-high
- steps: 4

With `agent_panel`, set @researcher to backend “Kiro CLI”, model `auto` and effort `high`. `auto` is Kiro’s router: it picks the model for each turn. Then send “@researcher, reply with the single word ok.” Once it has answered, read @researcher’s row in the Agents section, and say whether it names high effort, and no model from before the switch (such as “Opus 5.5, not auto”), with no “not” or “set to”.

## Phase 5: Antigravity, Gemini Flash

- triggers: ran-agy-flash-high, shown-agy-flash-high
- steps: 4

With `agent_panel`, set @researcher to backend “Antigravity CLI” and model `gemini-3.8-flash-high`, and effort `high`, which that model names. Then send “@researcher, reply with the single word ok.” Once it has answered, read @researcher’s row in the Agents section, and say whether it names gemini-3.8-flash-high and high effort, with no “not” or “set to”.

## Phase 6: Back to Claude Code, Haiku, max effort

- triggers: ran-cc-haiku-max, shown-cc-haiku-max
- steps: 4

With `agent_panel`, set @researcher to backend “Claude Code”, model `claude-haiku-5-5` and effort `max`. Then send “@researcher, reply with the single word ok.” Once it has answered, read @researcher’s row in the Agents section, and say whether it names Haiku 5.5 and max effort, with no “not” or “set to”.
