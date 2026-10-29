# Sprint 1: a kit for the next scrum master (27–29 October 2026)

A work-in-progress folder, not meant to merge. It holds what one Postbox room used to groom, estimate, plan and run a sprint, its blind retrospective, and what the next room needs to start from. Host names, accounts and local paths are left out.

## Start here

1. `retro/state-at-close.md`: what’s open, what’s waiting on the person, and what to clean up.
2. `retro/working-agreement-sprint2.md`: the room’s rules for sprint 2, with a measure for each new one and a glossary.
3. `setup.md`: setting up the room, as a checklist.
4. `retro/sprint-mechanics.md`: how sprint 1 ran, step by step, with velocity and the burndown.
5. `templates/`: blank round plan, estimation round, retrospective prompt and start-of-room check.

## The records

- **`retro/`:** the blind retrospective’s questions (`PROMPT.md`), the seven answers (`<handle>.md`: critic, developer, gpt and tester wrote files; claude-ssh and kiro-ssh-x86 posted in the room, copied here; researcher wrote first), the approved aggregate with a map from each theme to its sources (`aggregate.md`), and gpt’s comments, posted as text (`discussion-gpt.md`).
- **`grooming/`:**
  - `issues.json`, `app.html`, `build.py`: the 118 open issues and the grooming board app. `build.py` reads `gh issue list --state open --limit 200 --json number,title,labels,comments,updatedAt` saved as `/tmp/pb-issues.json`, and the same list with `--json number,milestone` as `/tmp/pb-ms.json`; its readiness, epic and points are the scrum master’s suggestions, written in the script.
  - `notes.json`, `board.html`: three agents’ urgency picks and their board.
  - `poker-round2.md`, `poker-revote.md`, `poker-208.md`, `poker-close.md`: the estimation scale and each round’s instructions; `estimates-*.json`, `revote-*.json`, `estimate208-*.json`, `estimates-close-*.json`: every estimator’s blind cards; `estimates-final.json`: the team’s estimates at planning.
  - `round1.md`: the round plan; `working-agreement.md`: the rules as they stood during sprint 1; `with-lock.sh`: the lock for heavy runs; `prior-work.md`: research behind the experiments; `sprint-board.html`: the sprint board and burndown app.
- **`figures/`:** `prs.sh` rebuilds `prs.json` from GitHub; `velocity.py` rebuilds `figures.md`, every number in `sprint-mechanics.md` §6.
- **`experiment-plan.md`:** the plan for testing the room’s own decisions. E2’s data is on `wip/e2-replay-data`.

## Paths in the records

The records were written in the room’s working folder, and name paths there. In this folder:

| The records say | Here |
|---|---|
| `.scratch/grooming/…` | `grooming/…` |
| `.scratch/retro-sprint1/…` | `retro/…` |
| `.scratch/experiments/plan.md` | `experiment-plan.md` |

The `.html` apps were written for Postbox’s app sandbox, and use its `postbox` object and color tokens, so they may not run as plain pages.
