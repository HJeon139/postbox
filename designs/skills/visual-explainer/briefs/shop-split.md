# Shop split: where the code would break

- **Idea:** The shop and admin code form two separate clusters around a shared library. Only three imports cross between them: two are a cycle between `shop/orders` and `admin/reports`, and one is `shop/checkout` reaching into `admin/users`. Those three are the split’s whole cost. The shared `lib/` modules, imported almost everywhere, aren’t a problem.
- **For:** A developer asked to split a codebase into two packages, shop and admin.
- **Question:** We want to split this into two packages, shop and admin; where would it break?
- **Facts** (from the run’s `src/`: 25 modules, 92 `import` lines):
  - `src/shop/`: 12 modules with 24 imports among themselves. `src/admin/`: 9 modules with 18 among themselves. `src/lib/`: 4 shared modules, the target of 47 imports.
  - `lib/format` is imported by 21 modules, and `lib/db` by 17.
  - Crossing imports: `shop/orders` → `admin/reports`, `admin/reports` → `shop/orders` (a cycle), and `shop/checkout` → `admin/users`.
- **Shape:** A network: modules and their imports, in two clusters with a shared hub.
- **Must show:** the two clusters; the shared library as something both use; the three crossing imports picked out, with the cycle visible as a cycle.
- **Traps:** a bar chart of how often each module is imported, which makes `lib/format` look like the problem; a matrix of 25 by 25 with no order; a box per folder with arrows between folders, which hides which modules cross.
