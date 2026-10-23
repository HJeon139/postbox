# Gemini room: a Claude Code agent and an Antigravity CLI agent (release runs only)

- persona: A data engineer choosing how to deduplicate a nightly import of about 40 million customer records from three source systems, where the same person can appear with different spellings, emails and addresses. Knows the data, is skeptical of fuzzy matching, and wants a second opinion from a reviewer that doesn’t think like the first. Writes short messages.
- agents: researcher
- backends: critic=antigravity-cli:gemini-3.8-flash-high
- project: Customer dedup
- conversation: Deduplicating the nightly import

@researcher runs on Claude Code. @critic runs on the Antigravity CLI with a Gemini model, so the two don’t share a model family’s blind spots (#143). This scenario runs only for a version release (`node tools/uat-run.mjs --scenario geminiroom --release`): the Antigravity CLI is on a free tier. Both agents should work the same way in the room: they answer with whatever suits the reply, wake each other, and define the terms they use. Antigravity can’t ask you to approve a tool call from Postbox: anything that would need asking is refused, shows as a refused step with a reason rather than a card, and ends @critic’s turn there. Antigravity also can’t turn off a tool you unticked for @critic; it only tells @critic not to use it. Notice anything about @critic that reads as Claude Code’s, or that it can’t do and doesn’t say so.

## Phase 1: Options, then a short plan

Ask @researcher how to deduplicate the import: exact keys after normalizing, a probabilistic record-linkage model, or clustering on embeddings, given the volume and that a wrong merge is worse than a missed one. Pick one of the approaches the way it lets you. Then ask it for a one-page plan for the approach you picked, and say you want @critic to look at it before you approve it.

## Phase 2: The second opinion, from Gemini

If @researcher hasn’t brought @critic in, ask it to. @critic should go through the plan line by line and say what it would change. Answer what it asks. Ask @critic to send its biggest concern back to @researcher, and check that @researcher answers it. Then ask @critic, in a new message, what its biggest concern was: it should remember, since each of its turns continues the same conversation. Both agents’ terms should link to definitions. Approve the plan once the concern is settled.

## Phase 3: A topic thread, and what the Antigravity agent may do

Start a topic thread from @critic’s most important comment, and ask @critic there to check one of its numbers by running a short calculation on this computer, such as a one-line Python command. It should start the thread knowing the comment it branched from. Its command should either run or be refused; if it’s refused, the step should say why, and @critic shouldn’t say you declined it. Then open @critic’s settings under Personas: it should say it runs on the Antigravity CLI with gemini-3.8-flash-high, that it always uses your Antigravity setup, and that an unticked tool is only a request. It shouldn’t list Claude Code’s MCP servers. Open the permissions panel for @critic: it should explain what it honors instead of showing Claude Code’s rules.
