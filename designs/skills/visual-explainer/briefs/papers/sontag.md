# Enzyme networks settle: why a Michaelis–Menten network reaches the same balance from any start

- **Idea:** Two runs that start far apart are pulled together, because the distance between them can only shrink, so every run ends at the same balance.
- **For:** Someone new to the field, with undergraduate chemistry.
- **Question:** Why does a network of enzymes reach the same balance wherever it starts?
- **Facts** (Sontag, [arXiv:2610.24351](https://arxiv.org/abs/2610.24351), preprint):
  - The paper proves that a network of enzymes following Michaelis–Menten kinetics, once it has a positive equilibrium, reaches it from every positive starting point. Earlier work (Blanchini, Breda, Giordano and Liessi) had shown only that the equilibrium is locally stable.
  - The key: the distance between any two states never increases over time, measured with the Thompson metric, the largest gap between their logarithms, $d_T(x, y) = \max_i |\ln x_i - \ln y_i|$.
  - Any concrete network drawn (a three-enzyme cycle, its rates, its starting amounts) is an illustration, not the paper’s.
- **Shape:** Process over time that converges.
- **Must show:** two runs from different starts; the distance between them over time, never rising; both ending at one balance.
- **Traps:** three equal panels with no reading order (the room’s first version); raw TeX in labels; an animation with no way to see the distance shrink; a single run, which can’t show that starts don’t matter.
