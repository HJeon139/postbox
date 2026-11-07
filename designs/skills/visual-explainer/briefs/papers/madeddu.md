# Diabetic marrow: how high blood sugar damages bone marrow

- **Idea:** High blood sugar harms the marrow through two separate branches, so a drug that cuts one branch leaves the other doing damage.
- **For:** Someone new to the field, with undergraduate chemistry.
- **Question:** How does high blood sugar damage bone marrow, and what could help?
- **Facts** (Madeddu, [arXiv:2610.24728](https://arxiv.org/abs/2610.24728), preprint; sections as cited in the room’s `marrow-toy` notes):
  - Glucose feeds two branches of a signaling network: a vessel branch, where reactive oxygen species (ROS) damage the vessel lining and weaken the barrier, and an inflammation branch, where the signal OSM raises CXCL12, which traps stem cells in the marrow. Progenitor injury and fat cells add to the damage.
  - Each part is low, medium or high, and each round it moves one step toward what its inputs ask for (Methods: the update rule).
  - Two drugs act on one branch each: a ROS drug on the vessel branch, an OSM block on the inflammation branch.
  - Four questions the paper leaves open change the outcome. Averaged over its model variants, the paper measured: +21.2 if vessel damage can heal, +15.2 if progenitor injury can heal, +13.6 if the OSM loop is switched off, +9.1 for the fat-cell loop (Results, Figure 5B).
  - The paper’s full model has 42 variables, and its rules are in a restricted supplement; any smaller network drawn is a simplification and must say so.
- **Shape:** Mechanism with two branches from one cause.
- **Must show:** glucose as the shared source; the two branches as separate paths to separate harms; where each drug cuts in; that cutting one branch leaves the other.
- **Traps:** a box per variable with its update rule written inside (the room’s first version); a 42-node network nobody can read; presenting a simplified network as the paper’s.
