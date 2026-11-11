# Harness mix: one contract for three harnesses

- persona: A developer who hands three agents a small task each and wants to see what each one is doing while it works, without asking them. Writes short messages.
- agents: researcher, critic, developer
- backends: critic=codex:gpt-6-luna, developer=antigravity-cli:gemini-3.8-flash-high
- project: Word counts
- conversation: Three harnesses at work
- steps: 10

@researcher runs on Claude Code (Haiku), @critic on Codex with GPT Luna, and @developer on the Antigravity CLI with Gemini Flash. Every adapter now reports its harness’s events through one contract, and Postbox builds the reply, the steps, the work ledger’s calls and Postbox’s own calls from it in one place. This run checks that all three read the same way: while a turn runs, its steps show open, each with its call’s input and the end of what it returned; a failed call says why; and Work lists each agent’s calls. It’s a compatibility run (`node tools/uat-run.mjs --scenario harnessmix --compat`), and its turns use each CLI’s own sign-in. Keep it short: two phases. Notice anything one harness’s steps show that another’s don’t, or any step that reads as noise.

## Phase 1: Three agents, each with tools to call

In one message, ask @developer to write `wordcount.py`, which prints the number of words in a text file given as its argument, and run it on a short file it makes; ask @critic to read `wordcount.py` once it exists and run it on two edge cases of its choosing, one of them a file that doesn’t exist; and ask @researcher to list the files in the project folder and say in two lines what each holds. While they work, look at each running reply: its steps should be open, each with what it was given and what it returned, for every backend, not only Claude’s. The run on a missing file should be a failed step that says why.

## Phase 2: Work

Open Work for the conversation. Each agent’s calls should be listed there, the files written and the commands run, named the same way whichever harness ran them. Say whether you could tell what each agent did, at every point, without asking it, and what was missing or noisy.
