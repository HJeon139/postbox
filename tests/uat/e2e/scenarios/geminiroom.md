# Gemini room: a Claude Code agent and an Antigravity CLI agent (release runs only)

- persona: A data engineer deduplicating a nightly import of about 40 million customer records from three source systems, where the same person can appear with different spellings, emails and addresses. Skeptical of fuzzy matching, and wants a second opinion from a reviewer that doesn’t think like the first. Writes short messages.
- agents: researcher
- backends: critic=antigravity-cli:gemini-3.8-flash-high
- project: Customer dedup
- conversation: Deduplicating the nightly import

@researcher runs on Claude Code. @critic runs on the Antigravity CLI with a Gemini model (#143). This run checks that @critic works in the room, not the plan itself, so keep it short: two phases, and move on as soon as each phase’s point has shown. It’s a compatibility run that also runs only for a version release (`node tools/uat-run.mjs --scenario geminiroom --release`, plus `--compat` once the runner has it): the Antigravity CLI is on a free tier. @critic should work as @researcher does: answer with whatever suits the reply, wake @researcher, and define the terms it uses. Antigravity can’t ask you to approve a tool call from Postbox: anything that would need asking is refused and shows as a refused step with a reason, not a card. agy ends the turn at a refusal, so Postbox resumes it once: @critic should then say which call was refused, not that you declined it. Antigravity also can’t turn off a tool you unticked for @critic; it only tells @critic not to use it. Notice anything about @critic that reads as Claude Code’s, or that it can’t do and doesn’t say so.

## Phase 1: A short plan, reviewed by Gemini

Tell @researcher you’ve chosen probabilistic record linkage, with exact keys first, and ask it for a short plan, no more than ten lines, for @critic to review before you approve it. @critic should go through the plan and say what it would change. Ask @critic to send its biggest concern to @researcher, and check that @researcher answers it. Then ask @critic, in a new message, what its biggest concern was: it should remember, since each of its turns continues the same conversation. Approve the plan once the concern is settled.

## Phase 2: A topic thread, and what the Antigravity agent may do

Start a topic thread from @critic’s most important comment, and ask @critic there which comment the thread is about and to check one of its numbers with a one-line Python command on this computer. It should know the comment it branched from. Its command should either run or be refused; if it’s refused, the step should say why, and @critic should say so in the thread. Then open @critic’s settings under Personas: it should say it runs on the Antigravity CLI with gemini-3.8-flash-high, that it always uses your Antigravity setup, and that an unticked tool is only a request. It shouldn’t list Claude Code’s MCP servers. Open the permissions panel for @critic: it should explain what it honors instead of showing Claude Code’s rules.
