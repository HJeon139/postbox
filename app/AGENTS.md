# The client: app/

Plain ES modules in `app/js/`, no framework and no build (designs/architecture.md, “The front end”). The page imports `shared/` as `/shared/…`. The root `AGENTS.md` applies here too.

## The DOM and agent content

- Build the DOM with `h()` from `app/js/dom.mjs`. Agent and app text goes in as text nodes (designs/engineering-practices.md, “The DOM, and agent content”).
- HTML comes only from `renderMarkdown()` output wrapped in `trusted()`; `h()` adds any other `html` as text, never markup. Never pass agent data where `h()` takes props: a plain object there became `innerHTML` (#30).
- No `innerHTML` without a `lint-allow dom:` comment naming its source, and no attribute or style names chosen at run time. `lint-dom` checks both.
- Don’t trust an id across conversations. Check who owns it (#31).

## Look and motion

- Every color is a design token. `lint-tokens` flags raw colors, and `check:contrast` checks every pair in both themes and on the app stage.
- Amber (`--accent`) is the only interaction color. Status colors are for rings and state only (designs/intent.md, “Visual language”).
- Every animation eases in, eases out, then rests. Respect `prefers-reduced-motion`: motion stops, and the glyph, the color and the words still carry the state.

## Accessibility and keyboard

The target is WCAG 2.1 AA, with no axe violations in any demo scene (designs/engineering-practices.md, “Accessibility (axe)”).
- Every control works by keyboard. Focus returns to where it came from when a dialog or menu closes, and stays on the control you used when a block re-renders.
- Nothing appears only on hover, apart from hover cards, which open by keyboard too.
- Icon buttons get an `aria-label`, groups get a role and a label, and a button’s name matches its visible text. State never rests on color alone.
- Don’t put `aria-pressed` on radios, leave a field unlabeled, or make a scroll container the keyboard can’t reach.

## Modules

- One concern per module. `thread.mjs`, `sheets.mjs` and `shell.mjs` are at their ceilings: a new concern goes in a module of its own, as `needs-nav.mjs` and `open-asks.mjs` did.
- A module that paints itself on store changes subscribes with `client.on`, and finds its elements by a `data-` attribute (`open-asks.mjs` is the pattern).
- `app/js/` isn’t type-checked yet (#313). Write JSDoc types anyway, at module boundaries.
