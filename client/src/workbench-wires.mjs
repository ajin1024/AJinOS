const pad = (r, n) => ({ left: r.left - n, right: r.right + n, top: r.top - n, bottom: r.bottom + n });
const inside = (p, r) => p.x > r.left && p.x < r.right && p.y > r.top && p.y < r.bottom;
export function smoothWire(from, to, nodes, headers, router) {
  const a = nodes[from],
    b = nodes[to];
  if (!a || !b) return "";
  const horizontal = b.left >= a.right;
  const start = { x: a.right, y: (a.top + a.bottom) / 2 };
  const end = { x: b.left, y: (b.top + b.bottom) / 2 };
  let c1, c2;
  if (horizontal) {
    const bend = Math.max(16, (end.x - start.x) * 0.48);
    c1 = { x: start.x + bend, y: start.y };
    c2 = { x: end.x - bend, y: end.y };
  } else {
    start.x = (a.left + a.right) / 2;
    start.y = a.bottom;
    end.x = b.left;
    end.y = (b.top + b.bottom) / 2;
    c1 = { x: start.x, y: end.y };
    c2 = { x: end.x - 35, y: end.y };
  }
  const obstacles = [
    ...Object.entries(nodes)
      .filter(([id]) => id !== from && id !== to)
      .map(([, r]) => r),
    ...headers,
  ];
  let blocked = false;
  for (let i = 1; i < 80; i++) {
    const t = i / 80,
      u = 1 - t;
    const p = {
      x: u ** 3 * start.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * end.x,
      y: u ** 3 * start.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * end.y,
    };
    if (obstacles.some((r) => inside(p, pad(r, 3)))) {
      blocked = true;
      break;
    }
  }
  if (!blocked) return `M${start.x},${start.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${end.x},${end.y}`;
  const points = router(from, to);
  if (!points.length) return "";
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i],
      prev = points[i - 1],
      next = points[i + 1];
    const l1 = Math.hypot(p.x - prev.x, p.y - prev.y),
      l2 = Math.hypot(next.x - p.x, next.y - p.y),
      r = Math.min(14, l1 / 2, l2 / 2);
    d += ` L${p.x + ((prev.x - p.x) * r) / l1},${p.y + ((prev.y - p.y) * r) / l1} Q${p.x},${p.y} ${p.x + ((next.x - p.x) * r) / l2},${p.y + ((next.y - p.y) * r) / l2}`;
  }
  return d + ` L${points.at(-1).x},${points.at(-1).y}`;
}
export function segmentHits(a, b, r) {
  return a.x === b.x
    ? a.x > r.left && a.x < r.right && Math.max(a.y, b.y) > r.top && Math.min(a.y, b.y) < r.bottom
    : a.y > r.top && a.y < r.bottom && Math.max(a.x, b.x) > r.left && Math.min(a.x, b.x) < r.right;
}
const ports = (r) => {
  const x = (r.left + r.right) / 2,
    y = (r.top + r.bottom) / 2;
  return [
    { x: r.left - 5, y, end: { x: r.left, y }, axis: 0 },
    { x: r.right + 5, y, end: { x: r.right, y }, axis: 0 },
    { x, y: r.top - 5, end: { x, y: r.top }, axis: 1 },
    { x, y: r.bottom + 5, end: { x, y: r.bottom }, axis: 1 },
  ];
};

export function createWireRouter({ nodes, regions, headers, width, height }) {
  const obstacles = [...Object.values(nodes), ...headers].map((r) => pad(r, 5));
  const regionBounds = Object.entries(regions).map(([id, r]) => [id, pad(r, 5)]);
  const xs = new Set([-12, width + 12]),
    ys = new Set([-12, height + 12]);
  for (const r of [...obstacles, ...regionBounds.map(([, r]) => r)]) {
    xs.add(r.left);
    xs.add(r.right);
    ys.add(r.top);
    ys.add(r.bottom);
  }
  for (const node of Object.values(nodes))
    for (const p of ports(node)) {
      xs.add(p.x);
      ys.add(p.y);
    }
  const xx = [...xs].sort((a, b) => a - b),
    yy = [...ys].sort((a, b) => a - b);
  const vertices = yy.flatMap((y) => xx.map((x) => ({ x, y })));
  const free = vertices.map((p) => !obstacles.some((r) => inside(p, r)));
  const graph = vertices.map(() => []);
  for (let i = 0; i < vertices.length; i++) {
    if (!free[i]) continue;
    for (const j of [i % xx.length < xx.length - 1 ? i + 1 : -1, i + xx.length]) {
      if (j < 0 || j >= vertices.length || !free[j]) continue;
      const a = vertices[i],
        b = vertices[j];
      if (obstacles.some((r) => segmentHits(a, b, r))) continue;
      const axis = a.x === b.x ? 1 : 0,
        distance = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      graph[i].push({ to: j, axis, distance });
      graph[j].push({ to: i, axis, distance });
    }
  }
  const index = (p) => yy.indexOf(p.y) * xx.length + xx.indexOf(p.x);
  return (from, to) => {
    if (!nodes[from] || !nodes[to]) return [];
    const excluded = regionBounds
      .filter(([id]) => id !== nodes[from].region && id !== nodes[to].region)
      .map(([, r]) => r);
    const targets = ports(nodes[to]).filter((p) => free[index(p)]);
    const queue = [],
      costs = new Map(),
      previous = new Map(),
      starts = new Map();
    const push = (item) => {
      let i = queue.length;
      queue.push(item);
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (queue[parent].score <= item.score) break;
        queue[i] = queue[parent];
        i = parent;
      }
      queue[i] = item;
    };
    const pop = () => {
      const first = queue[0],
        last = queue.pop();
      if (queue.length) {
        let i = 0;
        while (i * 2 + 1 < queue.length) {
          let child = i * 2 + 1;
          if (child + 1 < queue.length && queue[child + 1].score < queue[child].score) child++;
          if (queue[child].score >= last.score) break;
          queue[i] = queue[child];
          i = child;
        }
        queue[i] = last;
      }
      return first;
    };
    const estimate = (p) => Math.min(...targets.map((t) => Math.abs(p.x - t.x) + Math.abs(p.y - t.y)));
    for (const port of ports(nodes[from])) {
      const at = index(port),
        key = at * 2 + port.axis;
      if (!free[at]) continue;
      costs.set(key, 0);
      starts.set(key, port.end);
      push({ key, cost: 0, score: estimate(port) });
    }
    while (queue.length) {
      const item = pop(),
        { key, cost } = item;
      if (cost !== costs.get(key)) continue;
      const at = Math.floor(key / 2),
        axis = key % 2,
        p = vertices[at];
      const target = targets.find((t) => t.x === p.x && t.y === p.y);
      if (target) {
        const points = [target.end, p];
        let cursor = key;
        while (previous.has(cursor)) {
          cursor = previous.get(cursor);
          points.push(vertices[Math.floor(cursor / 2)]);
        }
        points.push(starts.get(cursor));
        points.reverse();
        return points.filter((point, i) => {
          if (i === 0 || i === points.length - 1) return true;
          const a = points[i - 1],
            b = points[i + 1];
          return !((a.x === point.x && b.x === point.x) || (a.y === point.y && b.y === point.y));
        });
      }
      for (const edge of graph[at]) {
        const next = vertices[edge.to];
        if (excluded.some((r) => segmentHits(p, next, r))) continue;
        const nextKey = edge.to * 2 + edge.axis,
          nextCost = cost + edge.distance + (axis === edge.axis ? 0 : 18);
        if (nextCost >= (costs.get(nextKey) ?? Infinity)) continue;
        costs.set(nextKey, nextCost);
        previous.set(nextKey, key);
        push({ key: nextKey, cost: nextCost, score: nextCost + estimate(next) });
      }
    }
    return [];
  };
}
