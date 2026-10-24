# Reaction icons

The five reactions (#251), each at 64 and 128 px, transparent and square. The page draws the 64 px one at 20 px in a
reaction and in the React menu (app/js/reactions.mjs). The emoji stays each icon’s accessible label. The 128 px files
are kept as the source for larger sizes.

| File | Emoji | Says | Drawing |
|---|---|---|---|
| `reaction-approve-*.png` | 👍 | Good | a heart postage stamp, as an embroidered patch, in sage green |
| `reaction-disapprove-*.png` | 👎 | Not good | a red slash stamp (a no-entry sign), as a sticker, in vermilion |
| `reaction-flag-*.png` | 🚩 | Flag this | a red pennant on an envelope, as an embroidered patch, in bright coral |
| `reaction-unclear-*.png` | ❓ | Unclear | a yellow envelope with a purple ?, as an embroidered patch |
| `reaction-done-*.png` | ✅ | Done | a turquoise check seal, as an embroidered patch |

## How they were made

Generated locally with FLUX.2 [dev] (`black-forest-labs/FLUX.2-dev`, 28 steps) and chosen by the person on 24 October
2026. `recipes.json` holds each one’s full recipe: its prompt, seed, guidance, terms and style references.

| Icon | Style | Seed | Guidance |
|---|---|---|---|
| approve | embroidered patch | 570560817 | 4 |
| disapprove | sticker (with one image reference) | 1603745149 | 4 |
| flag | embroidered patch | 396248151 | 3.5 |
| unclear | embroidered patch | 1356083644 | 4.5 |
| done | embroidered patch | 924688338 | 4.5 |

FLUX.2 [dev] is under Black Forest Labs’ FLUX [dev] Non-Commercial License; its model card allows commercial use of
the outputs. Whether this set ships under Postbox’s Apache-2.0 license is for the person to confirm. Their confirmation
on #263 covered the earlier set.

## Contrast

On light, the cream borders of the stamp, the slash and the envelope blend into the page. So workbench.css gives every
icon a 1 px `--dim` rim there; on dark they stand out on their own. The measure is the 80th percentile of an icon’s
pixels’ WCAG contrast against what’s behind it, at 20 px on a 2× screen. The person’s own chip is on the amber wash
(the worse of the wash over the page and over the panel); an agent’s chip is on the panel. Non-text needs 3:1.

| Icon | Light, yours, no rim | Light, yours, with rim | Light, an agent’s, with rim | Dark, yours | Dark, an agent’s |
|---|---|---|---|---|---|
| approve | 2.0 | 4.4 | 5.9 | 11.3 | 14.8 |
| disapprove | 2.7 | 3.6 | 4.6 | 12.5 | 16.4 |
| flag | 1.5 | 4.5 | 6.0 | 11.9 | 15.6 |
| unclear | 7.7 | 5.2 | 6.9 | 8.2 | 10.8 |
| done | 9.5 | 8.7 | 11.7 | 8.3 | 11.0 |

The rim itself is `--dim`: 5.0:1 on the light wash and 6.7:1 on the light panel.
