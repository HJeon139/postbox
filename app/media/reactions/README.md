# Reaction icons

The five reactions (#251), each at 64 and 128 px, transparent and square. The page draws the 64 px one at 20 px in a
reaction and in the React menu (app/js/reactions.mjs). The emoji stays each icon’s accessible label.

| File | Emoji | Says | Drawing |
|---|---|---|---|
| `reaction-approve-*.png` | 👍 | Good | a heart postage stamp, as an embroidered patch, in sage green |
| `reaction-disapprove-*.png` | 👎 | Not good | a red slash stamp (a no-entry sign), as a sticker, in vermilion |
| `reaction-flag-*.png` | 🚩 | Flag this | a red pennant on an envelope, as an embroidered patch, in bright coral |
| `reaction-unclear-*.png` | ❓ | Unclear | a yellow envelope with a purple ?, as an embroidered patch |
| `reaction-done-*.png` | ✅ | Done | a turquoise check seal, as an embroidered patch |

On light, the cream borders of the stamp, the slash and the envelope blend into the page, so workbench.css gives every
icon a thin `--dim` rim there. On dark they stand out on their own.

Made locally with FLUX.2 [dev] (`black-forest-labs/FLUX.2-dev`), 28 steps. `recipes.json` has each icon’s full recipe:
prompt, seed, guidance and terms, with its contrast as measured when it was chosen. FLUX.2 [dev] is under Black Forest
Labs’ FLUX [dev] Non-Commercial License; its model card allows commercial use of the outputs.
