# Settings: Hosts

**Where:** Settings › Hosts.

## Why it exists

Agents can run on another computer you reach with `ssh`. Its hosts are managed as every other kind of thing is (#1735): a list with one picked, and one bar of controls. A host’s state is what you came to see, so the pick’s card shows under the list. What a host does, and how to check it on a real one, is in [the remote hosts checklist](../../remote-hosts.md).

## Expected functionality

- **The list** has each host by name with its status in a line (“Not heard from yet” until its daemon answers), in the order they were added. The first is picked.
- A click or the arrow keys move the pick, and focus goes with it. One card shows, the pick’s, with its status, what its daemon found (each harness’s line ends “Signed in” or “Not signed in” once the host has said, #1608, with a warning and its login command to copy for each sign-out), and Install….
- **The bar**, at the right end of the “Hosts” heading’s row above the list: + (Add a host), − (Remove, which asks first) and Edit, each naming the pick.
- The bar’s + shows the New host form in the list’s place, with focus in SSH destination, Add host pinned under it, and “All hosts” to go back with the pick kept. The host you add is picked.
- Edit, Enter or a double click opens the picked host’s settings in its card, with Save and Cancel pinned under the sheet, and the bar away until the edit ends. Cancel returns focus to Edit. Picking another host closes an editor left open, without saving.
- The list draws again when a host’s status changes; a control of the bar that had focus keeps it.

## Steps to reproduce

1. Run Postbox on a data folder of its own (`node server/index.mjs --port 4181 --data /tmp/pb-uat-hosts --fresh`) and open <http://127.0.0.1:4181/>.
2. Open Settings › Hosts. Press +, type `build.example.com` and press Add host. Do the same for `gpu.example.com`.
3. Focus the first row and press ArrowDown, then ArrowUp.
4. Press Edit, change nothing, pick the other host, then pick this one again.
5. Press − and Cancel, then − and remove the host.

**Pass if:** After step 2 both hosts are listed and the one added last is picked. In step 3 the pick, the card and focus move together, twice. In step 4 the editor is closed when you come back. In step 5 Cancel returns to the list, and the removed host is gone from it.

## How to check

`npx playwright test tests/browser/main-menu-lists.spec.mjs tests/browser/hosts.spec.mjs tests/browser/hosts-add.spec.mjs tests/browser/hosts-status.spec.mjs`
