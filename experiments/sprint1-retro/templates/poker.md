# Estimation round <n> (<date>)

A point is relative effort to the Definition of Done (cause, code and failing tests, verification including real-backend or remote runs, reviews). Not time, not lines. Unknowns only the work can answer raise a number; an open decision gets `?`. Points rank; they aren’t agent-days.

Cards: 1, 2, 3, 5, 8, 13, `?` (can’t estimate, or a decision is open: say what you’d need), `split` (bigger than the 13 reference: say where to cut).

References (merged PRs, with facts from GitHub):
- 1 = <PR>: <commits, reviews, real runs, files>
- 3 = <PR>: …
- 5 = <PR>: …
- 8 = <PR>: …
- 13 = <PR>: …

Items (scope in one line each):
- #<issue>: <scope>

**Blind cards:** write `estimates-<round>-<your handle>.json` as `[{ "item": "#468", "card": 3, "driver": "one line" }]`, without opening the others’ files, then post only “done” with its sha256. Cards that differ by more than one step get one re-vote; still apart after that, the item goes to the person as `?`.
