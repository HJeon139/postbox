#!/bin/sh
# Rebuilds prs.json, the sprint's PRs with their open and merge times, from GitHub.
# Run from this folder: sh prs.sh
for n in 451 494 495 496 497 498 500 501 502 505 509 511 512 513 514 522 536 541; do
  gh pr view "$n" -R HJeon139/postbox --json number,title,headRefName,createdAt,mergedAt,state
done | python3 -I -c 'import json,sys; print(json.dumps([json.loads(l) for l in sys.stdin.read().replace("}\n{","}\x00{").split("\x00")], indent=1))' > prs.json
