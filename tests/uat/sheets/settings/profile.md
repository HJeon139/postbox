# Settings: Profile

**Where:** Settings › Profile. Your initials in the top bar open Settings on it.

## Why it exists

Agents call you “the person”, and nothing tells one that a GitHub login on a pull request, a commit’s author and the person in the room are the same one (#558). Here you say who you are, in your own words, and agents are told.

## Expected functionality

- **Name** starts as your computer’s account’s name, and the line under it says so, and that agents aren’t told it until you save. Once you have saved, it holds what you saved: a name you emptied stays empty.
- **Also written as**: other names that are yours, one a line, as “github: your-login” or “git: Your Commit Name”. A line with no kind Postbox knows is kept as “other”. Up to 12; a thirteenth is refused, saying so, and what was saved stays.
- **Preferences**, **Time zone** and **Pronouns**: free text, each one line once saved.
- Every field is optional, and each stops at its bound as you type, so a save never cuts what you see.
- **Save profile** says “Profile saved”, and agents read it from their next turn, in a conversation that’s already running too.
- **What agents are told** shows the turn’s own lines as saved, or “Nothing yet: agents call you ‘the person’.” The line under it says that clearing a field stops Postbox telling agents, that an agent that already heard it may remember it in that conversation, and that a new conversation starts clean.
- With nothing saved, agents are told nothing of you, whatever the account’s name. Your messages still come from “The person”.
- The top bar’s initials follow the name you saved, else the account’s.

## Accessibility

- Settings opens with keyboard focus on the Profile tab, the one that’s open.
- Each field’s help is its description (`aria-describedby`), and the top bar’s button is named “Settings”, whatever initials it shows.

## How to check

`npx playwright test tests/browser/profile.spec.mjs`, at 1280 and 375 px, with the axe audit. With real agents: `node tools/uat-run.mjs --scenario profile --max-turns 30 --budget 2 --max-cost 8 --file no`.
