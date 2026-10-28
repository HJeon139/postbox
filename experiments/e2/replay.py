# E2 replay from this folder's data alone: the pair-limit policies over the recorded wake sequences (plan.md revision 8).
# Usage: python3 -I replay.py > replay-check.json
# It reproduces replay3-result.json, which was computed from the stores themselves. The detector's calls are taken from
# the data (`detector`), because the working room's text isn't published; uat-wakes.jsonl has the text it ran on.
import json, os, sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
HOP_LIMIT = 10
LOOP = {'FM-1.3', 'FM-1.5'}


def load(name):
    return [json.loads(l) for l in open(os.path.join(HERE, name))]


wake = {w['id']: w for w in load('uat-wakes.jsonl') + load('room-wakes.jsonl')}
convs = {}
for c in load('sequences.jsonl'):
    seq = []
    for e in c['events']:
        if e['kind'] == 'reset':
            seq.append({'kind': 'reset'})
        else:
            w = wake[e['id']]
            seq.append({'kind': 'wake', 'from': w['from'], 'to': w['to'], 'label': w['label'], 'det': w['detector']})
    convs[(c['data'], c['conversation'])] = seq


def run(seqs, policy, nothing_of, loop_of):
    cards = false_stops = held = delivered_loop = past3 = longest = 0
    by = {'pair': 0, 'chain': 0}
    for seq in seqs.values():
        pairs, chain, card = defaultdict(lambda: {'all': 0, 'run': 0, 'loop': 0}), 0, False
        for e in seq:
            if e['kind'] == 'reset':
                pairs.clear(); chain = 0; card = False
                continue
            p = pairs[frozenset((e['from'], e['to']))]
            nothing = nothing_of(e)
            stop_pair = policy(p, nothing)
            if stop_pair or chain + 1 > HOP_LIMIT:
                false_stops += e['label'] == 'NEW'
                if card:
                    held += 1
                else:
                    cards += 1; card = True
                    by['pair' if stop_pair else 'chain'] += 1
                continue
            p['all'] += 1
            p['run'] = p['run'] + 1 if nothing else 0
            chain += 1
            looping = loop_of(e)
            p['loop'] = p['loop'] + 1 if looping else 0
            if looping:
                delivered_loop += 1
                past3 += p['loop'] >= 3
                longest = max(longest, p['loop'])
    return {'cards': cards, 'cards_by_pair_rule': by['pair'], 'cards_by_chain_limit': by['chain'], 'wakes_held': held,
            'false_stops': false_stops, 'loop_wakes_delivered': delivered_loop, 'loop_wakes_past_3rd': past3, 'longest_loop_delivered': longest}


POLICIES = {
    'limit 2 (now)': (lambda p, n: p['all'] + 1 > 2, None),
    'limit 6': (lambda p, n: p['all'] + 1 > 6, None),
    'content rule, detector': (lambda p, n: n and p['run'] + 1 > 2, 'det'),
    'content rule, oracle': (lambda p, n: n and p['run'] + 1 > 2, 'oracle'),
}
out = {}
for name in ('room', 'uat'):
    data = {k: v for k, v in convs.items() if k[0] == name}
    for cname, loop_of in (('loop tags only (decides)', lambda e: e['label'] in LOOP), ('every NOTHING wake', lambda e: e['label'] != 'NEW')):
        res = {}
        for pname, (pol, src) in POLICIES.items():
            if src == 'det':
                nothing_of = lambda e: e['det'] == 'NOTHING'
            elif cname.startswith('loop'):
                nothing_of = lambda e: e['label'] in LOOP
            else:
                nothing_of = lambda e: e['label'] != 'NEW'
            res[pname] = run(data, pol, nothing_of, loop_of)
        out[f'{name} | {cname}'] = res
json.dump(out, sys.stdout, indent=1)
print()
