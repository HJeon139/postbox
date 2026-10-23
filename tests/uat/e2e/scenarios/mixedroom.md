# Mixed room: a Claude Code agent and a Kiro CLI agent

- persona: A platform engineer deciding how to cache responses for an internal API that serves about 2,000 requests a second, mostly reads, with data that changes a few times an hour. Knows the service well, has opinions, and wants a second opinion from someone who doesn’t think like the first. Writes short messages.
- agents: researcher
- backends: critic=kiro-cli:gpt-5.6-terra
- project: API caching
- conversation: Caching the catalog API

@researcher runs on Claude Code. @critic runs on the Kiro CLI with an OpenAI model, so the two don’t share a model’s blind spots (#117). Both should work the same way in the room: they answer with whatever suits the reply, wake each other, and define the terms they use. Kiro can’t ask you to approve a tool call from Postbox: anything that would need asking is refused, and shows as a refused step with a reason rather than a card. Notice anything about @critic that reads as Claude Code’s, or that it can’t do and doesn’t say so.

## Phase 1: Options, then a short design note

Ask @researcher how to cache the catalog API: in the service, in a shared cache in front of it, or at the edge, given the traffic and how often the data changes. Pick one of the approaches the way it lets you. Then ask it for a one-page design note for the approach you picked, and say you want @critic to look at it before you approve it.

## Phase 2: The second opinion

If @researcher hasn’t brought @critic in, ask it to. @critic should go through the note line by line and say what it would change. Answer what it asks. Ask @critic to send its biggest concern back to @researcher, and check that @researcher answers it. Both agents’ terms should link to definitions. Approve the note once the concern is settled.

## Phase 3: A topic thread, and what the Kiro agent may do

Start a topic thread from @critic’s most important comment, and ask @critic there to check one of its numbers by running a short calculation on this computer, such as a one-line Python command. It should start the thread knowing the comment it branched from. Its command should either run or be refused; if it’s refused, the step should say why and @critic should say so, not that you declined it. Then open @critic’s settings under Personas: it should say it runs on the Kiro CLI with gpt-5.6-terra, and not list Claude Code’s MCP servers. Open the permissions panel for @critic: it should explain what it honors instead of showing Claude Code’s rules.
