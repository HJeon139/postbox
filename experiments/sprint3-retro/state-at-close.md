# State at the close of sprint 3 (6 November 2026)

What sprint 4 inherits. Each PR row was checked with `gh pr list --state open` at the close (exit 0), with `main` at `89cca534`.

## Open PRs

| PR | What | Head | State | Next |
|---|---|---|---|---|
| #825 | a review block shows images from the agent’s folder (#780) | `f5bf06d4` | changes requested | lead-cards: the alt-escape spec and its mutant, then #828’s points |
| #783 | a server bench by room size, and #508’s before and after numbers | `35a4d2fd` | changes requested | lead-delivery: the integrator’s points; first find what starts CodeQL on a retargeted PR (a close and reopen didn’t) |
| #773 | the view probe, view-moved and window-paged-back (#531, B1b-c) | `62b0c7b6` | no label; CI green | the person: s3-773-handback-r2 was still open at the close |
| #808 | Postbox removed from a host by hand is put back with a new token (#464-b3) | `addfe382` | no review; base now `main` | lead-host-install: get CodeQL to run on the retargeted head, then the body, then critic |
| #615 | #305’s design, archiving older turns (draft 7) | `70be51b8` | draft, parked | parked by the person |

## Work carried into sprint 4

| Item | State | Why it moved |
|---|---|---|
| #825 (#780) | changes requested | the alt escape in `shared/markdown-inline.mjs` has no test |
| #783, #773, #808 | open | as above |
| #564-a (8), #564-b5 (5) | not started | no capacity after the hotfix lane; b5 waits on b1–b4 |
| #821a–d (8, 8, 5, 5) | estimated | a design note first |
| #712a (5) | not started | moved by the person after its accessibility and Tab P1s |
| #711, A1b’s code | design merged (#781) | shrunk to the design this sprint |
| #817 (P1) | filed | a mod can approve a call past Postbox’s card (#806) |
| #796 (P1) | filed | no slot |
| the generic allow list | draft | needs a design pass with the team, after #817 |
| #670, #671-b | not started | ranked below the hotfix lane |
| follow-ups | filed | #779, #782, #789, #799, #800, #803–#807, #814, #815, #818, #820, #822, #827 |

## Decisions waiting on the person

- Whether to raise each build host’s “Stop a quiet turn after” setting (`stallTimeout`) as a workaround until Draft C lands.
- The four issue drafts in `action-items.md`, and the retrospective issue.
