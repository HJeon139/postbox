# The design docs: designs/

These docs hold the reasons. `AGENTS.md` files hold the rules that come from them. A change to one rule changes both, in the same commit. The root `AGENTS.md` applies here too.

## What goes where

- `intent.md`: the product decisions, and its “Writing” section, which governs every word in the repo.
- `architecture.md`: each engineering decision, numbered, as a decision, what it rests on, and when to revisit it. A new dependency or a new boundary is decided here before its code lands.
- `engineering-practices.md` and `developing.md`: the gate, and what a review checks that the gate can’t.
- `prompts/`: one prompt per session’s work, and `prompts/README.md`, “Rules for every session”.

## Writing a design doc

These come from designs/developing.md, “Proofreading”, “Draw the relationship; don’t describe it” and “Progress in living documents”:
- Every factual claim has a source: a link that resolves, a fixture, a measurement or an issue. A claim with none is hearsay.
- Refer to another section by its title, never its number, since sections get renumbered.
- Draw a relationship in Mermaid, never ASCII art and never a paragraph that describes the arrows.
- A living document says where things stand and what’s next, and is updated in the same change that moves them.
- Write for someone with no context from the session that wrote it.
