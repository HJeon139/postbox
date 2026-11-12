# Agent apps and the block catalog

What agents send to Postbox: blocks from a fixed catalog, the events the page applies, apps agents write that run sandboxed in the conversation, and narration. The decisions behind them are in [architecture.md](architecture.md) and its children, chiefly [sandbox.md](architecture/sandbox.md) and [narration.md](architecture/narration.md).

## The block catalog

A block is JSON naming one component. Agents send it with the `show_block` tool. Every block has these fields:

| Field | Required | Notes |
|---|---|---|
| `id` | Yes | Letters, digits and `- _ . :`. Sending the same id with `update_block` replaces the block; one that asks again (a choice, form, confirm or review) moves to the newest point, with a line where it was. An id names one block of its agent’s in a conversation, so `show_block` refuses an id that agent already showed there. |
| `type` | Yes | One of the components below. |
| `version` | Yes | The component version. This app reads version 1 of each. |
| `title` | No | Up to 200 characters. |
| `fallback` | Yes | Plain text shown if the block can’t be rendered. Write it so the person can still answer in the chat. |

Every block is validated before it’s shown ([`shared/catalog.mjs`](../shared/catalog.mjs)). An unknown type, a newer version, a missing field or a misspelled field gets the fallback text and a collapsed **Show the raw block**. It never fails silently and never breaks the transcript. Objects are strict, so an unknown field is an error.

| Component | Fields | Your action → the event’s `action` and `values` |
|---|---|---|
| `choice` | `options: [{ id, label }]` (1–24), `prompt?`, `multiple?`, `max?`, `other?: { label, placeholder? }`, `submitLabel?` | `choose` → `{ selected: [ids], other? }` |
| `form` | `fields: [{ id, label, kind: text \| longtext \| number \| select \| toggle \| date, required?, placeholder?, help?, min?, max?, step?, maxLength?, options?: [{ id, label, description? }], default? }]` (up to 24, each label up to 120 characters; options for a select only, up to 50, as objects, never strings), `prompt?`, `submitLabel?` | `submit` → `{ [fieldId]: value }`, already checked: numbers are numbers, dates are `YYYY-MM-DD`, selects are option ids |
| `table` | `columns: [{ id, label, kind?: text \| number, sortable? }]`, `rows: [{ id, cells: { [columnId]: value } }]` (up to 5,000), `rowAction?: { id, label }` | `<rowAction.id>` → `{ rowId }` |
| `progress` | `steps: [{ id, label, state: pending \| running \| done \| failed, detail?, duration? }]` | None. Move it on with `update_block`. |
| `card` | `body?`, `facts?: [{ label, value }]`, `actions?: [{ id, label }]` (up to 3) | `<action.id>` → `{}` |
| `confirm` | `statement` (say exactly what will happen), `confirmLabel`, `cancelLabel?` | `confirm` or `cancel` → `{}` |
| `image` | `src` (https from an allowed origin), `alt` (required), `caption?`, `width?`, `height?` | None |
| `code` | `code`, `language?`, `filename?` | None. A Copy button is built in. |
| `review` | `format: markdown \| code \| app`, `content` (markdown and code), `appId` (app), `previous?` (shows a diff; Postbox counts revisions), `threads?: [{ id, line? \| anchor?, status: open \| resolved, comments: [{ author, text }] }]`, `language?`, `filename?`, `files?: [{ name?, path }]` (markdown: images from the agent’s folder, `path` where each is and `name` a plain file name, PNG, JPEG, GIF or WebP, that the content shows by name or path) | `submit` → `{ verdict: comment \| approve \| request_changes, comments: [{ line? \| anchor?, text }] }` |
| `app` | `code` (HTML with inline script and style), `permissions?: [tool names]` | Whatever the app sends (see below) |

Long text fields (`prompt`, `body`, `statement`, review content) are Markdown. Short labels are plain text.

**Answering.** A `choice`, `form`, `confirm` or `review` turns read-only once you answer, and shows what you chose. Only a new block, or an update to the same id, can ask again. An update that sets `outcome` (Markdown, up to 500 characters) on an answered `choice`, `form` or `confirm` doesn’t ask: it reports the result as a line under your answer, the block stays answered, and its agent doesn’t need you. Your action also appears in the transcript as a short line in your voice, such as “Chose: weekly · Monday 9:00”. Your answer is for the revision you saw: if the agent changed the block while you were answering, Postbox refuses the answer, keeps what you entered, and shows what changed, so you answer again. And an update over an answer the agent hasn’t read yet (it waits while the agent works), whether it asks again or sets `outcome`, is refused, so your answer stays and no result lands under it unread. An open asking block makes its agent **need you**: its ring pulses and you get a notification.

**Safety.** Markdown is rendered by [`shared/markdown.mjs`](../shared/markdown.mjs), which escapes everything. Raw HTML is shown as text, links are checked and open in a new tab with `rel="noopener noreferrer"`, and nothing an agent sends becomes a tag, an attribute name or a style.

## The event shape

When you act in a block or an app, the agent receives one message:

```json
{ "kind": "event", "event": { "blockId": "start-book", "revision": 1, "action": "choose", "values": { "selected": ["walden"] } } }
```

The event is built and checked by [`shared/events.mjs`](../shared/events.mjs) before it’s sent. `revision` is the revision of the block you answered: 1 when it’s shown, and one more with each `update_block`. Apps’ events have none. A form with mistakes doesn’t produce an event: you see a message under each field instead (“Enter a number from 5 to 200.”). These are all the messages an agent can receive:

| `kind` | When | Fields |
|---|---|---|
| `user` | You wrote to the agent | `text`, `attachments` |
| `event` | You acted in a block or an app | `event: { blockId, revision, action, values }` |
| `agent` | Another agent woke it | `from: "@handle"`, `text` |
| `wake` | A wake-up it scheduled | `note` |
| `app-check` | An app it wrote failed the pre-display check | `appId`, `problems: [{ code, message }]` |
| `lint` | Its reply used terms it never defined | `undefinedTerms: [{ term, key }]` |
| `notice` | Something Postbox wants it to know, such as a wake you didn’t allow | `text` |

## Agent-written apps

`show_app({ id, title, code, permissions })` shows an app inline at the thread’s full width. The app runs in an iframe whose page is served with the policy `sandbox allow-scripts`, so it gets an opaque origin and no same-origin access. (The policy is a response header rather than the iframe’s `sandbox` attribute, because some embedded browsers refuse frames with the attribute. Postbox’s bridge only answers frames with an opaque origin.) Its content-security policy allows its own inline code, the kit and bundled libraries, and nothing else: no fetch, no websockets, no forms, no nested frames. The page is served by [`server/sandbox.mjs`](../server/sandbox.mjs).

Inside the sandbox, the kit ([`app/kit/kit.js`](../app/kit/kit.js)) provides:

| Call | What it does |
|---|---|
| `postbox.ready` | Resolves to `{ state, theme, appId }` once Postbox says hello |
| `postbox.query(tool, args)` | Asks the host for data. It works only for tools in the app’s `permissions` that its agent also holds, such as `narrate.speak`. Every agent holds its conversation’s assets, so `assets.search` (the room’s text assets by words and meaning, a passage at a time) and `assets.list` need only the app’s `permissions`. |
| `postbox.file(name)` | A data file the agent attached to this version with `files`, as text (#54). |
| `postbox.send(action, values, summary)` | Sends one event to the agent. `summary` is the line you see in your voice. |
| `postbox.saveState(obj)`, `postbox.restoreState()` | Saved state survives unloading, reloading and new versions |
| `postbox.anchors({ name: element })` | Parts you can pin review comments to |
| `postbox.on('theme', fn)` | Light and dark tokens update by themselves; redraw canvas or D3 output here |
| `postbox.load('d3' \| 'katex' \| 'mermaid')` | Loads a bundled library |
| `postbox.charts.line / scatter / stacked / heatmap / table` | Charts built to the design rules, each with a Chart and Table view |
| `postbox.narration(el, passages, opts)` | A player that reads passages aloud with a local voice, with a transcript that follows along. Needs `narrate.speak`. |
| `postbox.narrate(text, opts)` | One clip, as `{ url, ms }` |

The stylesheet is preloaded, so apps use the same classes and tokens as Postbox, on the cool app stage.

**Images.** An app loads images from `data:` URLs, or from `/media/<name>`. That serves the media bundled with Postbox, then the `media/` folder in your data folder (`~/.postbox/media/`), where agents copy the images their apps show (PNG, JPEG, GIF, WebP, AVIF or SVG). Agents find it in `$POSTBOX_MEDIA`. Nothing an agent adds goes into Postbox’s own folder, which an upgrade replaces.

**The pre-display check.** Before you see an app, your browser loads it in two hidden frames, at 375 and 1280 px. It checks for:
- sideways overflow
- fields and buttons without labels
- images without alt text
- positive `tabindex`
- low-contrast text
- script errors

The first failure goes back to the agent as an `app-check` message. If the next version still fails, the app is shown with a note. A script error shows a “stopped working” card with Reload and Ask to fix.

**Lifecycle.** An app reloads from its saved state as you approach it, and unloads when it’s well off screen. A same-size placeholder keeps the transcript from jumping. A new version brings the app to the newest point in the conversation, beside the agent’s note about it, and leaves one line where it was that leads to it. It’s the same app, with its saved state, and older versions stay in its version menu.

## Narration

Agent apps can read text aloud with `postbox.narration(el, passages)`, a player whose transcript follows the voice, or `postbox.narrate(text)` for one clip. The app needs the `narrate.speak` permission, and its agent the tool.

The voice is [Kokoro](https://github.com/hexgrad/kokoro) (via `kokoro-js`). It runs on this computer in a child process, so its native packages stay out of the server. The model, about 100 MB, downloads into `models/` in the data folder the first time anything is read aloud. After that, a passage takes a second or two, and the same text is never synthesized twice. See the narrated walkthrough in [designs/recipes.md](recipes.md).
