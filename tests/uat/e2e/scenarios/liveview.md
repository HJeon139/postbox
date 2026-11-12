# Live view: four agents at work in one room

- persona: A developer who hands four agents a small task each in one message and wants to follow what each one is doing while it works, without asking them. Writes short messages, and drops a note into the room while they work.
- agents: researcher, critic, developer, alpha
- project: Word counts
- conversation: Four agents at work
- steps: 10

Four agents on Claude Code work in one room at once. While a turn runs, its reply shows the turn as it happens: the agent’s words and its thoughts, whole, between its steps, in the order they happened. The newest step shows in full: an edit as a small diff, a command with the end of its output. Older steps are one line each, an edit with its +n −n. Each agent’s block fits its share of the screen, and past that, older steps fold into “N earlier steps”. When a turn ends, its steps fold into one line at the top of its post, the turn’s work record, which opens to the steps and to the turn in Work. This run checks that you can follow all four without asking them (designs/rooms-at-scale.md, “Live state”). Notice anything you had to ask an agent, any step that reads as noise, and any reply that jumps or breaks apart.

## Phase 1: Four agents at once, and a note while they work

In one message, ask @developer to write `wordcount.py`, which prints the number of words in a text file given as its argument, and run it on a short file it makes. Ask @alpha to write a test file for it with three cases and run it once `wordcount.py` exists. Ask @critic to read `wordcount.py` once it exists and run it on a file that doesn’t exist. Ask @researcher to list the files in the project folder and say in two lines what each holds. While they work, look at each running reply: its words and steps should read in the order they happened, the newest step in full, and the older ones as one line each. The run on a missing file should be a failed step that says why. About 20 seconds in, while they still work, post a one-line note to the room, such as “Keep the output to one number.” The replies still running should go on below your note: their later steps and words together there, not split with the steps above your note and the words below it.

## Phase 2: Finished turns, and Work

Once every agent is done, look at each post: its steps should be one line at the top, the turn’s work record, saying what it changed and ran. Open one: it should list the steps and link to the turn in Work. Nothing under the post should say that line again. Follow the link, and say whether Work matches what the record said. Then say whether you could tell what each agent did, at every point, without asking it, and what was missing or noisy.
