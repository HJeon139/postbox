# E2: replaying the pair limit (#492) over recorded agent wakes

Data and code for the experiment summarized on #492, 28 October 2026. This is a work-in-progress branch: it isn’t meant to merge, and it will be deleted once #492 is decided.

## What’s here

| File | What it holds |
|---|---|
| `plan.md` | The experiment plan, revision 8, with each decision rule fixed before the data it judges |
| `rubric.md` | How each wake was labeled, revision 4, with MAST’s definitions ([Cemri et al., arXiv:2503.13657](https://arxiv.org/html/2503.13657)) |
| `uat-wakes.jsonl` | The 179 wakes from 14 UAT runs: who woke whom, the wake’s text and the 3 messages before it between the same two agents (redacted, below), the settled label, and the detector’s call |
| `room-wakes.jsonl` | The 258 wakes from one working conversation: who woke whom, the settled label and the detector’s call. **No text:** this conversation is real work, not synthetic |
| `sequences.jsonl` | Each conversation’s wakes and resets in time order, with times relative to its first event: the replay’s input |
| `labels-*.jsonl` | Each labeler’s labels for the pilot (51), the held-out round (51) and the rest (337), and the settled labels (`labels-final.jsonl`) |
| `rest-disagreements.jsonl`, `heldout-settlements.md` | Every disagreement between the two labelers, with both settlements |
| `replay.py` | The replay, run from this folder’s data alone |
| `replay3-result.json` | The result, as computed from the original stores |
| `report-r3.md` | The report, with the decision rule applied |

## Check the result

```sh
python3 -I replay.py > replay-check.json
```

`replay-check.json` matches `replay3-result.json` exactly. The working room’s detector calls are taken from the data, since its text isn’t published.

## The UAT runs

All synthetic: scripted scenarios with a simulated person and real agents.

| Scenario | Runs | Wakes |
|---|---|---|
| p0 | 3 | 84 |
| hostwakes | 4 | 42 |
| remotehosts | 2 | 26 |
| workroom | 2 | 14 |
| needsnav | 2 | 7 |
| longresearch | 1 | 5 |
| uc03-verse | 1 | 1 |

## Redaction

In `uat-wakes.jsonl`, host names, account names, home folders, local workspace paths and 12-digit machine ids are replaced by `<test-host>`, `<host>`, `<user>`, `<home>`, `<workspace>` and `<machine-id>`. A scan of every file here for host names, account names, local paths, ssh details, emails, IP addresses and secret-like strings found none left. The only “ssh” matches are the agent handles `claude-ssh` and `kiro-ssh-x86`.
