# Harness mix: one contract for four harnesses

- persona: A developer who hands four agents a small task each and wants to see what each one is doing while it works, without asking them. Writes short messages.
- agents: researcher, critic, developer, alpha
- backends: critic=codex:gpt-6-luna, developer=antigravity-cli:gemini-3.8-flash-high, alpha=kiro-cli:gpt-5.6-terra
- project: Word counts
- conversation: Four harnesses at work
- steps: 10

@researcher runs on Claude Code (Haiku), @critic on Codex with GPT Luna, @developer on the Antigravity CLI with Gemini Flash, and @alpha on the Kiro CLI with GPT Terra. Every adapter reports its harness’s events through one contract (`server/harness-events.mjs`), and Postbox builds each running reply’s live view from it in one place: the agent’s words and thoughts between its steps, the newest step in full and the older ones as a line each; and, once the turn ends, its one-line work record. This run checks that all four read the same way. An edit shows its diff where its harness says the change: Claude Code, Codex and Kiro’s whole-file writes do; Antigravity’s stream names only the file, so its edits show no diff. It’s a compatibility run (`node tools/uat-run.mjs --scenario harnessmix --compat`), and its turns use each CLI’s own sign-in. Keep it short: two phases. Notice anything one harness’s live view shows that another’s doesn’t, or any step that reads as noise.

## Phase 1: Four agents, each with tools to call

In one message, ask @developer to write `wordcount.py`, which prints the number of words in a text file given as its argument, and run it on a short file it makes; ask @alpha to write a test file for it with three cases and run it once `wordcount.py` exists; ask @critic to read `wordcount.py` once it exists and run it on two edge cases of its choosing, one of them a file that doesn’t exist; and ask @researcher to list the files in the project folder and say in two lines what each holds. While they work, look at each running reply, for every backend, not only Claude’s: its words and steps should read in the order they happened, the newest step in full, and the older ones as one line each. The run on a missing file should be a failed step that says why.

## Phase 2: Finished turns, and Work

Once every agent is done, look at each post: its steps should be one line at the top, the turn’s work record. Open one from each backend: it should list the steps and link to the turn in Work. Open Work for the conversation. Each agent’s calls should be listed there, the files written and the commands run, named the same way whichever harness ran them. Say whether you could tell what each agent did, at every point, without asking it, and what was missing or noisy.
