// Place graph labels near their marks on a fixed-height drawing (#888).
{
  const GAP = 4;
  const CELL = 24;

  const cells = (box) => {
    const keys = [];
    for (let y = Math.floor(box.top / CELL); y <= Math.floor(box.bottom / CELL); y++) {
      for (let x = Math.floor(box.left / CELL); x <= Math.floor(box.right / CELL); x++) keys.push(`${x}:${y}`);
    }
    return keys;
  };

  const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

  const occupy = (grid, box, keys = cells(box)) => {
    for (const key of keys) {
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(box);
    }
  };

  const tryPlace = (grid, label, x, y, width, height) => {
    const left = x - label.w / 2 - GAP;
    const box = { left, right: x + label.w / 2 + GAP, top: y - label.h, bottom: y + GAP };
    if (left < 4 || box.right > width - 4 || box.top < 4 || box.bottom > height - 4) return null;
    const keys = cells(box);
    if (keys.some((key) => grid.get(key)?.some((prior) => overlaps(prior, box)))) return null;
    occupy(grid, box, keys);
    return { ...label, x, y };
  };

  const offsets = [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ];

  const placeLabel = (grid, label, width, height, distance) => {
    for (const [dx, dy] of offsets) {
      const center = label.x + dx * (distance + label.w / 2 + GAP);
      const inset = label.w / 2 + GAP + 4;
      const x = Math.max(inset, Math.min(width - inset, center));
      const y = label.y + dy * (distance + (dy > 0 ? label.h : GAP)) + (dy === 0 ? label.h / 2 : 0);
      const placed = tryPlace(grid, label, x, y, width, height);
      if (placed) return placed;
    }
    return null;
  };

  window.__pbGraphLabels = (labels, nodes, width, height) => {
    const grid = new Map();
    for (const { x, y, r } of nodes) occupy(grid, { left: x - r, right: x + r, top: y - r, bottom: y + r });
    return labels.map((label) => placeLabel(grid, label, width, height, label.r) ?? placeLabel(grid, label, width, height, label.r + 12)).filter(Boolean);
  };
}
