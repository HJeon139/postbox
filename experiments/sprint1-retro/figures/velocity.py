"""Rebuilds the sprint's velocity and burndown figures from prs.json and the estimates.

Run from this folder: python3 -I velocity.py > figures.md
Points: the committed items' cards from ../grooming/estimates-final.json (#208's from estimate208-*.json), and
the median of the three blind cards in ../grooming/estimates-close-*.json for the PRs never estimated before.
"""
import glob, json, statistics
from datetime import datetime, timezone

def at(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00')) if s else None

# Points per PR. The committed five come from the sprint's planning; the rest from the close estimates.
COMMITTED = {494: 2, 495: 5, 496: 8, 497: 5, 498: 3}
LATER = {522: 10}  # #466: retry 5 + recovery 5, estimates-final.json
CLOSE_ITEM = {511: '#504', 514: '#510', 513: '#503', 500: '#484', 502: '#499', 505: '#483', 509: '#478',
              512: '#486', 501: '#475 #476 #477', 536: '#485', 541: '#492', 451: 'hostwakes'}
cards = {}
for f in glob.glob('../grooming/estimates-close-*.json'):
    for x in json.load(open(f)):
        key = 'hostwakes' if x['item'].startswith('hostwakes') else x['item']
        cards.setdefault(key, []).append(x['card'])
points = {**COMMITTED, **LATER, **{pr: statistics.median(cards[item]) for pr, item in CLOSE_ITEM.items()}}

prs = {p['number']: p for p in json.load(open('prs.json'))}
start = at('2026-10-28T04:33:00Z')
close = at('2026-10-29T18:42:00Z')
days = (close - start).total_seconds() / 86400

total = sum(points.values())
opened = [n for n in points if prs[n]['createdAt'] and at(prs[n]['createdAt']) <= close]
merged = [n for n in points if prs[n]['mergedAt']]
hours = sorted((at(prs[n]['mergedAt']) - at(prs[n]['createdAt'])).total_seconds() / 3600 for n in merged if n != 451)

print('# Sprint 1 figures (rebuilt by velocity.py)\n')
print(f'Sprint window: {start:%d %b %H:%M} to {close:%d %b %H:%M} UTC, {days:.2f} days.\n')
print('| PR | Points | Opened (UTC) | Merged (UTC) |')
print('|---|---|---|---|')
for n in sorted(points):
    p = prs[n]
    m = at(p['mergedAt'])
    print(f"| #{n} | {points[n]:g} | {at(p['createdAt']):%d %b %H:%M} | {m.strftime('%d %b %H:%M') if m else 'open'} |")
print()
print(f'- Points in the sprint, estimated: {total:g}, of which committed at planning: {sum(COMMITTED.values()):g}.')
print(f'- Points merged by the close: {sum(points[n] for n in merged):g}; open: {sum(points[n] for n in points if n not in merged):g}.')
print(f'- Velocity, merged: {sum(points[n] for n in merged if n != 451) / days:.1f} points a day over the sprint window (PR #451 left out: it opened before the sprint).')
print(f'- PR open to merge, sprint fix PRs: median {statistics.median(hours):.1f} h, from {hours[0]:.1f} to {hours[-1]:.1f} h, over {len(hours)} merged PRs.')
print('\n## Burndown of all estimated points (done = merged)\n')
print('| Time (UTC) | Points left | Event |')
print('|---|---|---|')
left = total - (points[451] if prs[451]['mergedAt'] and at(prs[451]['mergedAt']) < start else 0)
events = sorted((at(prs[n]['mergedAt']), n) for n in merged)
print(f'| {start:%d %b %H:%M} | {left:g} | sprint starts |')
for t, n in events:
    left -= points[n]
    print(f'| {t:%d %b %H:%M} | {left:g} | #{n} merged ({points[n]:g}) |')
