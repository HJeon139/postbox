# Glossary terms

![Glossary terms](../../screenshots/glossary-term.png)

**Where:** Dotted-underlined words in replies.

## Why it exists

Terms an agent coins in a session (“observation budget”) must stay understandable later.

## Expected functionality

- Defined terms link everywhere in the conversation and show their definition in a card on hover or focus.
- Undefined coined terms are flagged to the agent, which defines them: numbered ones such as “Phase 2”, and citation shorthands such as “R:31”, “§4.2” or a “#A” placeholder (#102). “L2”, “Table 3” and issue numbers such as “#208” aren’t flagged.
- A term matches as a whole word. A term of one or two characters matches only in its own case, and never inside an abbreviation: a term “R” links “R” and “R:31” but not “R&D” or a lowercase “r” (#102).
- Dash and quote variants link the same term: “U:45–52” defined links “U:45-52”, and the reverse (#102).
- A topic thread uses its conversation’s terms too. A term defined in the conversation while the topic thread is open links there at once, without reopening it (#564).
- Terms inside a definition link too, all but the term itself (#103). Hovering one opens its card over the first, up to three deep. Leaving the top card for the one under it closes only the top one, and a term whose card is already open (U → U:13 → U) opens nothing.
- By keyboard, Enter or Space pins a term’s card and moves focus into it, Tab reaches the terms inside, and Escape closes the top card and returns focus to its term.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. In “ReAct, step by step”, hover “observation budget”.
3. In a conversation where one definition names another term (an agent defines “U” as “… such as U:13”, then “U:13”), hover “U” until its card pins, then hover “U:13” inside it, then move back onto U’s card.
4. Open a topic thread whose reply uses a word that isn’t a term yet, and have an agent define that word in the conversation.

**Pass if:** The definition card opens. In step 3, both cards show, then only U’s, and each stays inside the window at 375 and 1280 px. In step 4, the word in the topic thread’s reply links as soon as it’s defined.

## Related

- [citations](citations.md)
