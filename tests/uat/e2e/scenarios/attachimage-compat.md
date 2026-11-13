# Attach an image on every backend: each agent says what a picture you attached shows

- persona: A designer who sends agents pictures and expects them to look. Writes short messages.
- agents: researcher, critic, developer, alpha, beta
- backends: beta=agent-sdk, critic=codex:gpt-6-luna, developer=antigravity-cli:gemini-3.8-flash-high, alpha=kiro-cli:qwen3-coder-next
- permission_modes: researcher=auto, critic=auto, developer=auto, alpha=auto, beta=auto
- project: Picture check
- conversation: What’s in the picture, five ways

The compatibility run of [attachimage](attachimage.md) (#1307): @researcher on Claude Code, @beta on the Agent SDK, @critic on Codex, @developer on the Antigravity CLI and @alpha on the Kiro CLI, all on this computer. Each gets the same attached PNG, at the path Postbox gives it, and opens it with its own tools. The picture’s name, `picture.png`, says nothing of what it shows. Watch for an agent that says it can’t read or see the file, reads it as text or binary, asks for permission to read it, or guesses.

`node tools/uat-run.mjs --scenario attachimage-compat --compat --budget 2 --max-cost 8 --file no`

## Phase 1: One picture, five agents

- triggers: attached-image-read-by-each
- steps: 4

Attach `picture.png` with `attach_file` and ask all five agents in one message, by name (@researcher, @critic, @developer, @alpha and @beta), what the picture shows: its shape, its color and any word in it. Don’t say what’s in it yourself. Once they’ve answered, say for each agent whether its reply names what the picture really shows, and whether it said it couldn’t open or see the file.

## Phase 2: The picture again, to the Kiro and Antigravity agents

- triggers: attached-image-read-again
- steps: 3

Attach `picture.png` again with `attach_file`, in a new message, and ask @alpha and @developer where in the picture the word sits. Kiro can’t ask you for permission from Postbox, and Antigravity asks before reading outside its folders, so these two show most plainly whether each can open the file. Say for each whether its reply names what the picture shows, and whether a permission card appeared.
