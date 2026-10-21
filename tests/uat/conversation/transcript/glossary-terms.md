# Glossary terms

![Glossary terms](../../screenshots/glossary-term.png)

**Where:** Dotted-underlined words in replies.

## Why it exists

Terms an agent coins in a session (“observation budget”) must stay understandable later.

## Expected functionality

- Defined terms link everywhere in the conversation and show their definition in a card on hover or focus.
- Undefined coined terms are flagged to the agent, which defines them.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. In “ReAct, step by step”, hover “observation budget”.

**Pass if:** The definition card opens.

## Related

- [citations](citations.md)
