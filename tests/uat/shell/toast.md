# Toast

![Toast](../screenshots/toast.png)

**Where:** Top right, after actions and blocking events.

## Why it exists

Confirms what just happened and offers a next step (Restore, Go) without a dialog.

## Expected functionality

- Appears in the Notifications region for permission requests and other blocking events from other conversations. A delete has no toast and no Undo: its confirm said what goes.
- Notices share one top-right stack of at most three, newest first; on a narrow screen it spans the available width. While a sheet is open, at every width, one notice shows, the newest, on one line each for its title and its text, in the sheet’s title row between its title and Close: no notice covers a tab or a control of the sheet. Under the pointer it shows its words whole. An older notice shows again if the sheet closes while it lasts. A notice is temporary: what must be found later is a message or a “needs you”. The gaps between notices take no click.
- Has an action button when one applies; disappears on its own; is announced to screen readers.

## Steps to reproduce

1. Run the demo (`node tools/demo.mjs --port 4180`) and open <http://127.0.0.1:4180/> while it plays; keep the tab open.
2. Press ⌃J while nothing needs you, then wait for an agent in another conversation to need you.

**Pass if:** Both notices appear in the same top-right Notifications stack, the newest first, and each disappears on its own.
