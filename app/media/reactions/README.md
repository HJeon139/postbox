# Reaction icons

The five reactions (#251), each at 64 and 128 px, transparent PNG with an 8% margin. The page draws the 64 px one at
20 px in a reaction and in the React menu (app/js/reactions.mjs). The emoji stays each icon’s accessible label.

| File | Emoji | Says | Drawing |
|---|---|---|---|
| `reaction-approve-*.png` | 👍 | Good | ! in a green badge: chess’s “good move” |
| `reaction-disapprove-*.png` | 👎 | Not good | ? in a burnt-orange badge: chess’s “mistake” |
| `reaction-flag-*.png` | 🚩 | Flag this | a mailbox with its red flag raised |
| `reaction-unclear-*.png` | ❓ | Unclear | ?! in a mustard badge: chess’s “dubious move” |
| `reaction-done-*.png` | ✅ | Done | a green wax seal with a check |

The chess meanings follow the standard annotation symbols (https://en.wikipedia.org/wiki/Chess_annotation_symbols).

Made locally with FLUX.2 [dev] at 512 px (28 steps, guidance 4), with crops of Postbox’s own screenshots as style
references, then backgrounds removed and downsampled with premultiplied alpha. FLUX.2 [dev] is under Black Forest
Labs’ non-commercial license; its model card allows commercial use of the outputs.
