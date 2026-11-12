# Prompt changes are reviewed as rendered text

Part of [the architecture](../architecture.md).

**Decision** (25 October 2026). What Postbox tells an agent is reviewed as a security change. CI renders what agents read on both sides of a pull request and scans it with SkillSpector, and the reviewers, an agent’s adversarial review and the maintainer, read the rendered diff. SECURITY.md, “Prompt changes”, says how to use it.

**No approval step** (#402). A required check that held such a pull request until the maintainer approved it in a GitHub environment was removed, with its list of prompt-surface paths: behavior is protected by review and UAT instead. Why:
- **The approval couldn’t show the change.** GitHub’s dialog names the environment, not the diff, so approving read as a click after the real review, which an agent and the maintainer did on the rendered text anyway.
- **It cost more than it caught.** In its first day it held every workflow, AGENTS.md and persona change for a click. An invalid edit to it (#391) blocked every pull request until #394, and a merge past it needed a ruleset bypass.

**What it rests on**
- **The text an agent gets isn’t in any one file.** The guide (`server/adapters/guide.mjs`) fills in limits, tool rules and session facts, and each backend hands it over in its own way: Claude Code appends it to the system prompt, Kiro puts it in the turn’s custom agent file, Codex sets it as developer instructions, and Antigravity wraps it in a rules file. `tools/prompt-surface.mjs` renders each persona’s whole guide, the MCP tool descriptions and the repo’s agent instructions, so a reviewer reads the result, not the code that builds it.
- **The scan can’t judge a pull request by itself.** It runs on `pull_request`, untrusted and without secrets, and a pull request can edit it. It’s the reviewer’s aid.
- **SkillSpector catches the generic attacks and misses Postbox’s own.** NVIDIA’s scanner (Apache-2.0, a CI tool, never a Postbox dependency) runs regular expressions, YARA rules and Python analysis; it doesn’t read JavaScript, which is why it scans the rendered text. Run with `--no-llm` on 14 threats seeded one at a time into a persona and the tool descriptions, it reported 9 as high: an override, a directive in an HTML comment, exfiltration to a URL, a hidden `.env`, pipe-to-shell, credential paths, anti-refusal, bidirectional-text hiding and a poisoned tool description. It missed all 5 that reword a rule of Postbox’s: skipping the review block, skipping the confirm block, treating web pages and files as instructions, approving its own refused tool call, and persistence through `~/.zshrc`. Its own exit code stayed 0 for 8 of the 9 it caught, so the job fails on new high or critical findings against the base instead.
- **On `main` it reported 7 medium findings** on 25 October 2026, and nothing higher: `npx @slidev/cli` without a version in the guide and in Antigravity’s copy of it, `npx playwright` three times in the repo’s own instructions, and “without asking” in two old session prompts. They’re the baseline a pull request is compared with.

**Revisit when** SkillSpector’s model analysis can run on a key the repository holds. Its semantic pass is the part meant to catch a reworded rule, and only the maintainer’s pull requests could use it, never a fork’s.
