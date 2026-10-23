# Prompt: wave 5, retiring apps and the app check (#193, #194, #89)

A wave 5 session. The triage session integrates it, and the architectural review session reviews it. Follow [README.md](README.md) for the rules every session shares. Your ports are 4900–4949 for servers and 10200–10249 for Chrome.

---

You’re letting agents retire an app, and making the pre-display check catch text and controls the person can’t read or use, on the branch `fix/w5-apps`, in one pull request. The first commits make room in `server/runtime.mjs` and `app/kit/kit.js` (README.md, “Length limits”), then one commit per issue.

## Why

All three came from the wave 4 manual UAT rooms, 22 and 23 October 2026:
- **#193:** agents can’t retire an app that’s no longer needed. @researcher’s practice lab was replaced by @critic’s metro map, and the only way out was a v4 holding one line, “This lab has moved: use … below”. `update_app` moves an app to the newest point (#49), so the pointer landed below the map and was wrong. It looked like a failed load, and the person reported that “the practice lab failed to load”.
- **#194:** the check passed a gallery whose left column’s text ran into the demo heading at every two-column width. The person found it from a screenshot. The check only tests overflow at the page level (`document.documentElement.scrollWidth > innerWidth`), so text that spills out of its own box but stays inside the page passes.
- **#89:** the check passed a row of filter buttons clipped to a 4 px strip. The app used `class="bar"`, which `app/workbench.css` already defines for progress bars, with `height: 4px; overflow: hidden`. The guide says “use its classes” but never lists them, and many of its 187 class names are generic ones an agent would pick.

The check exists so the agent hears about these before the person sees them (intent.md, Dynamic UI).

## Read first

- [README.md](README.md); `designs/intent.md`, Dynamic UI (the app rows, the pre-display check row and #49’s move-to-newest rule); `designs/architecture.md` on apps and §15.
- Each issue, with its proposal and acceptance.
- `registerApp`, `appCheck` and the app tools in `server/runtime.mjs` and `server/mcp.mjs`; `app/js/apps.mjs` (the frame, the version menu, unloading off screen); the check in `app/kit/kit.js`; the app section of `server/adapters/guide.mjs`.

## The work

- **First, make room:**
  - Move the app functions (`registerApp`, `appCheck`, `needAppSend`, `appState`, `appQuery`, `appFile`, `appFiles`) out of `server/runtime.mjs` into `server/apps.mjs`, unchanged, with their ceilings. Nothing else changes in that commit.
  - `app/kit/kit.js`’s check is one function far past the default. Move it into a module the sandbox loads beside the kit, unchanged, with its ceiling, if the sandbox can load it without a new origin or a build step. If it can’t, split the check into one function per kind of problem as its own commit, with no change in what it reports, and lower the ceiling.
- **#193:** `retire_app { id, reason, replacedBy? }`, as #193 proposes:
  - It works only on the calling agent’s own apps.
  - A retired app shows in its place as one quiet line, such as “Retired by @researcher: replaced by *metro map*”, with a link that scrolls to the replacement, and the version menu kept.
  - It loads no sandbox until the person opens a version.
  - Retiring doesn’t move the app to the newest point.
  - The guide’s app section says when to retire, in place of posting a pointer version.
- **#194:** two new problems in the check, at both widths, after the layout is quiet:
  - **`text-overflow`:** an element that directly holds text, with `overflow-x: visible`, whose `scrollWidth` is over its `clientWidth` by more than a pixel. The message names the text, its width and its box’s, and the usual fix.
  - **`text-overlap`:** text drawn over other text, as #194 defines it.
- **#89:**
  - **`control-hidden`:** a control with no size, clipped by an ancestor, or under another element at its center.
  - The guide lists the stylesheet classes an app may use on purpose, and says to prefix its own.

## Files

- **Yours:** `server/apps.mjs` and the lines in `server/runtime.mjs` that call it, `retire_app` in `server/mcp.mjs`, `app/js/apps.mjs`, the check in `app/kit/kit.js` and any module it moves to, the app section of `server/adapters/guide.mjs` (within `guideText`’s 9,000-character budget), `tools/checks/app-*.mjs`, and the app and kit tests.
- **Shared:**
  - **`server/runtime.mjs` and `biome.json`:** every wave 5 session moves its own concern out first. Move only the app functions, and lower `runtime.mjs`’s ceilings by what left.
  - **`server/mcp.mjs`:** the blocks session changes the block tools. Change only the app tools.
  - **The work list (#195)** lists published apps. Tell the integrator the retired state’s name, so its row can say so.

## Done when

- Each issue has a test that fails without its fix:
  - the gallery’s v1 layout fails `text-overflow`, and v2 passes
  - the `.bar` row fails `control-hidden`
  - a retired app renders as its line with its versions, and moves nowhere
- `checks/app-*` cover retiring in the page, clean with `--lag 300`.
- The UAT docs for apps say what changed (text only).
