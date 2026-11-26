# Settings: People

**Where:** Settings › People.

## Why it exists

Postbox knows who you are (#558), and a room’s Members list shows people beside agents. This is where everyone this Postbox knows is listed, in the same list every other kind of thing is managed in (#1735), so there is one place to see who is here.

## Expected functionality

- On your own computer the list has one row: you, by the name you saved or your account’s, marked “you”, with what you are mentioned by (`@` and the handle you saved, else your account’s login) and your pronouns if you saved them.
- The bar is pinned under the sheet: +, − and Edit. + and − are off, dimmed and still in the tab order: who is here isn’t added or removed in Postbox. The line under the list says so in words: “On this computer, you are the account Postbox runs as. There is no one to add or remove.”
- Edit, Enter or a double click on your row goes to [Profile](profile.md). A person edits only their own profile.
- The last line says what people see of each other: every room, and each other’s profile, and that agents are told of a person only what that person saved.

## Steps to reproduce

1. Run Postbox on a data folder of its own (`node server/index.mjs --port 4181 --data /tmp/pb-uat-people --fresh`) and open <http://127.0.0.1:4181/>.
2. Open Settings › People. Tab to + and press Enter, then to − and press Enter.
3. Press Edit.

**Pass if:** One row, yours, marked “you”. Neither press in step 2 does anything, and the reason is on the page without hovering. Step 3 opens the Profile tab.

## Accessibility

- The bar’s + and − are announced as off, with the reason as their description.

## How to check

`npx playwright test tests/browser/main-menu-lists.spec.mjs`
