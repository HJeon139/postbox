# Open topic: an agent opens a topic thread, and the agent it asks answers there

- persona: A team lead who likes each side question kept in its own thread beside the message it is about, and checks that nothing posts twice. Writes short messages.
- agents: alpha, beta
- project: Open topic
- conversation: Side questions in threads

@alpha and @beta are in the room, both on Claude Code. This is #637's acceptance run (designs/508/637-open-topic.md, spec 8): an agent opens the topic thread itself, with open_topic, rather than you opening it from the page.

## Phase 1: An agent opens a thread and asks another there

Ask @alpha for a three-line plan to rename a config key across a small project. Then ask @alpha to open a topic thread on that plan, using its open_topic tool, and to ask beta there whether any step is risky. Write beta's name without the @: an @-mention in your message wakes beta in the room. Don't open the thread from the page.

Pass if a topic thread sits beside @alpha's plan, @alpha's question appears in it once, and beta's answer to it is in that thread. A later room message of @alpha's that @-mentions beta wakes beta in the room: that's a room mention, not this check. Fail, and file it, if the thread isn't there, the question posts twice or not at all, or beta answers the thread's question only in the room.

## Phase 2: The same thread again, and a mistyped name

Ask @alpha to open a topic thread on the same plan again, and to pass mentions ["betta"] exactly as written (a deliberate typo, not beta) with a short note asking for a second look.

Pass if no second topic thread opens on the plan, the note appears in the existing thread once, and @alpha tells you no agent is called betta. Fail, and file it, if a second thread opens, or the note is lost.
