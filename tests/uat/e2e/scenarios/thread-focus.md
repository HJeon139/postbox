# Thread focus: a request in a topic thread is answered there

- persona: A team lead who keeps two pieces of work going in one room and checks each agent answers what it was asked, where it was asked. Writes short messages.
- agents: alpha, beta
- backends: beta=kiro-cli:gpt-5.6-terra
- project: Thread focus
- conversation: Two tasks at once

@alpha and @beta are in the room. @beta runs on the Kiro CLI, so the result covers more than one backend; run it again with beta on Claude Code.

## Phase 1: Room work for @beta

Ask @alpha to write a short Python function, demo/parser.py, that splits "key=value" lines, and to hand it to @beta for review in the room, with a long, detailed hand-off. Don’t mention @beta yourself. Let @beta review it and @alpha revise it once, so @beta has review work open in the room.

## Phase 2: A different request in a thread

Ask @alpha for a two-sentence status note as a review block. Start a topic thread on that block and ask there: "@beta please check only the English grammar of this note, nothing else." Meanwhile, in the room, ask @alpha to post a second revision of demo/parser.py for @beta.

Pass if @beta’s reply in the thread is about the note’s grammar, and any parser review it does is in the room. Fail, and file it, if @beta answers the parser work in the thread or ignores the grammar request.
