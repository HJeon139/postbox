# Switch an agent’s backend, model and effort: each switch takes effect

- persona: Someone who tries an agent on each Claude model to compare them. Writes short messages.
- agents: researcher
- permission_modes: researcher=auto
- project: Switching
- conversation: Which model is it

A targeted scenario for #1315, Claude only: one agent, @researcher, switched through its persona sheet between Claude Code and the Agent SDK, and between Opus, Sonnet and Haiku, each at a different effort. It starts on Claude Code with the run’s model. After each switch it takes a turn, and the run checks from what it recorded that the turn ran on the chosen backend (the turn’s stream is in `streams/` for Claude Code, `streams/sdk/` for the Agent SDK), that the backend reported the chosen model and effort, and that the agent’s row names them. Effort has no `auto` level (Low, Medium, High, Extra high and Max): the harnesses’ own `auto` model is in [switch-compat](switch-compat.md). Watch for a row that says “…, not …” or “set to …” after the turn, a sheet that saved something other than what was picked, and a turn that fails after a switch.

`node tools/uat-run.mjs --scenario switch --budget 2 --max-cost 6 --file no`

Each phase is one switch. Use `agent_panel` on @researcher with exactly the backend, model and effort it names: the model is typed into the Model field as written. Don’t change anything else.

## Phase 1: Agent SDK, Sonnet, low effort

- triggers: ran-sdk-sonnet-low, shown-sdk-sonnet-low
- steps: 4

With `agent_panel`, set @researcher to backend “Agent SDK”, model `claude-sonnet-5-5` and effort `low`. Say what the sheet held when it saved. Then send “@researcher, reply with the single word ok.” Once it has answered, read @researcher’s row in the Agents section, and say whether it names Sonnet 5.5 and low effort, with no “not” or “set to”.

## Phase 2: Claude Code, Haiku, high effort

- triggers: ran-cc-haiku-high, shown-cc-haiku-high
- steps: 4

With `agent_panel`, set @researcher to backend “Claude Code”, model `claude-haiku-5-5` and effort `high`. Say what the sheet held when it saved. Then send “@researcher, reply with the single word ok.” Once it has answered, read @researcher’s row in the Agents section, and say whether it names Haiku 5.5 and high effort, with no “not” or “set to”.

## Phase 3: Agent SDK, Opus, max effort

- triggers: ran-sdk-opus-max, shown-sdk-opus-max
- steps: 4

With `agent_panel`, set @researcher to backend “Agent SDK”, model `claude-opus-5-5` and effort `max`. Say what the sheet held when it saved. Then send “@researcher, reply with the single word ok.” Once it has answered, read @researcher’s row in the Agents section, and say whether it names Opus 5.5 and max effort, with no “not” or “set to”.

## Phase 4: Claude Code, Sonnet, extra high effort

- triggers: ran-cc-sonnet-xhigh, shown-cc-sonnet-xhigh
- steps: 4

With `agent_panel`, set @researcher to backend “Claude Code”, model `claude-sonnet-5-5` and effort `xhigh`. Say what the sheet held when it saved. Then send “@researcher, reply with the single word ok.” Once it has answered, read @researcher’s row in the Agents section, and say whether it names Sonnet 5.5 and extra high effort, with no “not” or “set to”.

## Phase 5: Agent SDK, Haiku, medium effort

- triggers: ran-sdk-haiku-medium, shown-sdk-haiku-medium
- steps: 4

With `agent_panel`, set @researcher to backend “Agent SDK”, model `claude-haiku-5-5` and effort `medium`. Say what the sheet held when it saved. Then send “@researcher, reply with the single word ok.” Once it has answered, read @researcher’s row in the Agents section, and say whether it names Haiku 5.5 and medium effort, with no “not” or “set to”.

## Phase 6: Claude Code, Opus, low effort

- triggers: ran-cc-opus-low, shown-cc-opus-low
- steps: 4

With `agent_panel`, set @researcher to backend “Claude Code”, model `claude-opus-5-5` and effort `low`. Say what the sheet held when it saved. Then send “@researcher, reply with the single word ok.” Once it has answered, read @researcher’s row in the Agents section, and say whether it names Opus 5.5 and low effort, with no “not” or “set to”.
