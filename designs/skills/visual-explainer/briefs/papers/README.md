# Paper briefs: the development set

Three arXiv preprints to tune the skill on before testing it on random recent papers. Each was already explained by agents in the Agent research room on October 24, 2026, so each has two baselines: the room’s first version (zero-shot) and its last (after 4 to 6 rounds of a person’s feedback), on the [`docs/agentic-ux-examples`](https://github.com/HJeon139/postbox/tree/docs/agentic-ux-examples/examples/agentic-apps) branch. The facts below come from those apps’ source notes, which cite the papers by equation and section.

| Brief | Paper | Shape | Room’s apps |
|---|---|---|---|
| [Diabetic marrow](madeddu.md) | Madeddu, [arXiv:2610.24728](https://arxiv.org/abs/2610.24728) | Mechanism with two branches | `marrow-toy` v1 to v5 |
| [Enzyme networks settle](sontag.md) | Sontag, [arXiv:2610.24351](https://arxiv.org/abs/2610.24351) | Process over time that converges | `sontag_mm_contraction` v1 to v5 |
| [A cell’s clock costs energy](jia.md) | Jia, [arXiv:2610.23310](https://arxiv.org/abs/2610.23310) | Trade-off across one setting | `markov-oscillation-efficiency` v1 to v7 |

These are the development set: change the skill freely to do better on them. The test set is different papers, drawn at random from recent arXiv listings, and the skill isn’t changed in response to them (the `visualpaper` scenario).
