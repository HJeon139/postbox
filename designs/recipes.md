# Recipes

A recipe is a pattern an agent can follow to make a good interactive reply: which parts of Postbox to combine, in what order, and what to watch for. Recipes aren’t components. Agents write each reply themselves; the recipes say what has worked. Every real agent gets a short version of them in its system prompt ([`server/adapters/guide.mjs`](../server/adapters/guide.mjs)), and the mock agent shows each one in the demo.

Use one when:
- the person asked for something a recipe covers
- or a reply in prose would take more than a screen

| Recipe | Made of | In the demo |
|---|---|---|
| Explorer | an app with `postbox.query('corpus.search')`, saved state, and a send-back action | Corpus explorer |
| Explainer with practice | Markdown with citations, a Mermaid diagram, math, `define_term`, then a practice app | ReAct, step by step |
| Narrated walkthrough | an app with slides and `postbox.narration()` | ReAct, out loud |
| Slidev export | a `slides.md` file in the agent’s folder, plus a code block | (needs a real agent) |
| Line-by-line review | a review block, then `update_block` with `previous` to show the diff | Corpus schema spec |
| Dashboard | an app with `postbox.charts.*`, each chart with a Table view | Corpus dashboard |
| Long job | a progress block with counts, moved on with `update_block`, every step closed, then a summary | Index the shelf |

## Narrated walkthrough

For walking someone through an idea step by step, out loud, like a short talk. The slides follow the voice, and the whole transcript stays on screen, so it works without sound.

1. Write the talk as passages first: one passage per slide, two or three sentences each, up to 1,200 characters. Write them to be heard: short sentences, no lists or symbols read aloud.
2. Write the slides: a title and a few words or a small diagram each. They support the voice; they don’t repeat it.
3. Show one app with permission `narrate.speak`. Its agent needs the `narrate.speak` tool too. In the app:

```js
postbox.ready.then(({ state }) => {
  show(state?.at ?? 0); // your own function that draws slide i and calls postbox.saveState({ at: i })
  postbox.narration(document.getElementById('narration'), passages, {
    label: 'Narration transcript',
    onPassage: (i) => show(i), // the slide follows the passage being read
  });
});
```

4. Add Previous and Next buttons for anyone who reads instead of listening.

The kit’s player:
- makes audio only when Play is pressed, one passage at a time, and fetches the next one while the current one plays
- marks the passage being read with `aria-current`, and lets you click any passage to start there
- if the voice isn’t available, it says so, and the transcript still reads in full

The voice is Kokoro, running on this computer in its own process ([`server/narration/`](../server/narration/)). Its model, about 100 MB, downloads into `data/models/` the first time anything is read aloud. Nothing is sent anywhere else.

## Slidev export

For a talk the person will give themselves, or a deck to keep. [Slidev](https://sli.dev) turns one Markdown file into slides.

1. Write `slides.md` in the agent’s folder with the Write tool:

```md
---
theme: default
title: ReAct in four slides
---

# ReAct in one line

The model alternates between thinking and acting.

---

# The loop

1. Thought
2. Action
3. Observation

<!-- Speaker notes go in HTML comments at the end of a slide. -->
```

2. Show it in the thread as a code block with `filename: "slides.md"`, so the person can copy it from there too.
3. Tell the person how to see it: `npx @slidev/cli slides.md` in that folder opens the deck, and `npx @slidev/cli export slides.md` makes a PDF. Postbox doesn’t run Slidev itself, because it would download a large toolchain the first time.

The same passages can serve both: the narrated walkthrough for listening now, and the Slidev deck’s speaker notes for presenting later.

## Writing your own

A good recipe:
- names the parts it uses, so anyone can follow it
- works without its richest part: without sound, with no network, at 375 px
- passes the pre-display check without being fixed

Add it to the table above and to the guide, and give the mock agent a way to show it, so the demo and the screenshots cover it.

## Long job

For work that takes more than a minute: indexing, reading several papers, a batch of edits. The person should be able to tell, at a glance, how far along it is and whether it’s still moving.

1. Show a progress block with one step per stage, or one per subagent when they run in parallel.
2. For a step with countable work, set `progress: { done, total, unit }` (“2 of 4 papers”), or `percent` when there’s nothing to count, and an optional short `eta` (“3 min”). Update the step as items finish, not only when it ends: at least every minute, or at each subtask.
3. Postbox stamps when the block last changed and when each step started and ended, shows a running step’s time live, and fills in `duration` when you leave it out.
4. Before the turn ends, close every step as `done` or `failed`, with a one-line `detail` for a failure. A step left `running` shows as stalled, and Postbox tells you to close it.
5. End with a short summary of what was done.
