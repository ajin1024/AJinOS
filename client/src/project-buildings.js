import * as T from "three";
import { islandStyle } from "./island-presets.mjs";

// Each style has a different silhouette; the front terrace remains a visible work area.
export function buildProjectIsland(w, v, id) {
  const s = islandStyle(id),
    g = v.group,
    c = s.color;
  const box = (a, b, d, col, x, y, z, r = 0.06) => w.box(g, a, b, d, col, x, y, z, r);
  const cyl = (a, b, h, col, x, y, z, n = 24) => w.cylinder(g, a, b, h, col, x, y, z, n);
  const roof = (width, y, z, color = c) => {
    for (const sign of [-1, 1]) {
      const m = box(width * 0.62, 0.16, 2.3, color, sign * width * 0.23, y, z);
      m.rotation.z = sign * -0.58;
    }
  };
  const window = (x, y, z) => box(0.38, 0.58, 0.06, "#a7e6ed", x, y, z);
  let height = 4.8;
  if (s.id === "lighthouse") {
    cyl(0.62, 0.92, 3.6, "#f6eee1", 0, 2.3, -0.6);
    for (const y of [1.4, 2.6, 3.6]) cyl(0.73, 0.77, 0.35, c, 0, y, -0.6);
    cyl(1.03, 1.03, 0.16, "#374c68", 0, 4.08, -0.6);
    cyl(0.6, 0.6, 0.85, "#ffe3a0", 0, 4.58, -0.6);
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3;
      cyl(0.045, 0.045, 0.92, "#34495c", Math.cos(a) * 0.63, 4.57, -0.6 + Math.sin(a) * 0.63, 8);
    }
    cyl(0, 0.95, 0.7, c, 0, 5.32, -0.6);
    w.ring(g, 0.94, 0.035, "#364d69", 0, 4.4, -0.6);
    for (const y of [1.6, 2.8]) window(0, y, 0.18);
    height = 6;
  } else if (s.id === "pagoda") {
    for (let i = 0; i < 3; i++) {
      const size = 3 - i * 0.65,
        y = 1 + i * 1.1;
      box(size, 0.8, size * 0.64, "#f4d7b0", 0, y, -0.65);
      for (const x of [-size * 0.39, size * 0.39]) box(0.16, 0.9, 0.16, c, x, y, 0.05);
      cyl(size * 0.48, size * 0.78, 0.5, c, 0, y + 0.57, -0.65, 4).rotation.y = Math.PI / 4;
      box(size * 1.14, 0.1, 0.12, "#f3bb65", 0, y + 0.36, size * 0.32 - 0.65);
    }
    cyl(0, 0.16, 0.7, "#efbb68", 0, 4.2, -0.65, 6);
  } else if (s.id === "greenhouse") {
    box(3.8, 0.2, 2.9, "#e7d9bb", 0, 0.6, -0.55);
    const glass = w.mat("#92dccc", 0, true);
    for (const x of [-1.65, 1.65]) {
      const wall = box(0.08, 1.7, 2.4, c, x, 1.5, -0.55);
      wall.material = glass;
    }
    for (const x of [-1.7, 0, 1.7]) box(0.09, 1.9, 0.09, c, x, 1.6, -1.75);
    for (const z of [-1.75, -0.55, 0.65]) {
      for (const sign of [-1, 1]) {
        const beam = box(2.1, 0.09, 0.09, c, sign * 0.84, 2.9, z);
        beam.rotation.z = -sign * 0.6;
      }
    }
    for (const sign of [-1, 1]) {
      const panel = box(2.1, 0.045, 2.4, c, sign * 0.84, 2.9, -0.55);
      panel.rotation.z = -sign * 0.6;
      panel.material = glass;
    }
    box(0.09, 0.09, 2.6, c, 0, 3.5, -0.55);
    for (const x of [-1, 0, 1]) {
      cyl(0.3, 0.22, 0.4, "#c77b56", x, 0.87, -0.9);
      w.tree(g, x, -0.9, 0.65, x === 0);
    }
    height = 4.3;
  } else if (s.id === "forge") {
    box(3.5, 1.8, 2, "#846151", -0.15, 1.5, -0.6);
    for (const x of [-1.25, -0.15, 0.95]) {
      const saw = box(1.2, 0.16, 2.2, c, x, 2.55, -0.6);
      saw.rotation.z = 0.35;
      window(x, 1.6, 0.43);
    }
    for (const [x, h] of [
      [-0.9, 3.6],
      [0.9, 4.4],
    ]) {
      cyl(0.23, 0.36, h, "#5b6573", x, 0.6 + h / 2, -1.25, 10);
      cyl(0.32, 0.32, 0.23, c, x, h + 0.55, -1.25, 10);
    }
    const gear = w.ring(g, 0.55, 0.12, c, 1.5, 1.5, 0.65);
    gear.rotation.x = 0;
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4,
        cog = box(0.2, 0.22, 0.18, c, 1.5 + Math.cos(a) * 0.57, 1.5 + Math.sin(a) * 0.57, 0.65);
      cog.rotation.z = a;
    }
    height = 5.5;
  } else if (s.id === "observatory") {
    cyl(1.65, 1.75, 1.6, "#eee3d6", 0, 1.35, -0.7);
    const dome = w.mesh(
      g,
      w.geo("project-dome", () => new T.SphereGeometry(1.72, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2)),
      w.mat(c),
      0,
      2.17,
      -0.7,
    );
    w.ring(g, 1.73, 0.08, "#aebcdd", 0, 2.2, -0.7);
    const telescope = cyl(0.24, 0.38, 2.25, "#d4d9e5", 0.6, 3.35, 0.1);
    telescope.rotation.z = -0.65;
    telescope.rotation.x = 0.65;
    for (const x of [-0.85, 0, 0.85]) window(x, 1.5, 0.84);
    height = 4.6;
  } else if (s.id === "windmill") {
    cyl(0.75, 1.3, 2.8, "#f1dfb5", 0, 1.95, -0.75, 8);
    cyl(0, 1.15, 1.2, c, 0, 3.9, -0.75, 8);
    const blades = new T.Group();
    blades.position.set(0, 3, 0.35);
    g.add(blades);
    for (let i = 0; i < 4; i++) {
      const arm = new T.Group();
      arm.rotation.z = (i * Math.PI) / 2 + 0.35;
      blades.add(arm);
      w.box(arm, 0.12, 1.9, 0.12, "#766457", 0, 0.9, 0);
      w.box(arm, 0.48, 1.25, 0.09, "#f5efe1", 0.16, 1.12, 0.04);
      for (let j = 0; j < 4; j++) w.box(arm, 0.5, 0.035, 0.12, c, 0.16, 0.65 + j * 0.3, 0.09);
    }
    w.ball(g, 0.21, c, 0, 3, 0.5);
    height = 5.4;
  } else if (s.id === "library") {
    for (let i = 0; i < 5; i++) {
      const book = new T.Group();
      book.position.set(0, 0.95 + i * 0.62, -0.65);
      book.rotation.y = i % 2 ? -0.16 : 0.15;
      g.add(book);
      w.box(book, 2.65, 0.42, 1.9, "#efe2c8");
      for (const y of [-0.25, 0.25]) w.box(book, 2.9, 0.1, 2.08, i % 2 ? c : "#586d9c", 0, y, 0);
      w.box(book, 0.2, 0.55, 2.08, i % 2 ? c : "#586d9c", -1.36, 0, 0);
      for (const y of [-0.1, 0, 0.1]) w.box(book, 2.4, 0.015, 0.02, "#c7b99e", 0.08, y, 0.965);
    }
    w.ball(g, 0.46, "#efc47e", 0, 4.1, -0.65, 1, 0.3);
    height = 4.9;
  } else if (s.id === "spaceport") {
    cyl(1.8, 1.8, 0.25, "#52667f", 0, 0.7, -0.6, 12);
    w.ring(g, 1.45, 0.06, "#e6b777", 0, 0.86, -0.6);
    cyl(0.59, 0.59, 2.4, "#e9eef0", 0, 2.5, -0.6);
    cyl(0, 0.59, 1.2, "#d56a5b", 0, 4.3, -0.6);
    cyl(0.39, 0.58, 0.55, c, 0, 1.05, -0.6);
    for (const x of [-0.8, 0.8]) {
      const fin = box(0.22, 1.4, 0.9, "#d56a5b", x, 1.6, -0.6);
      fin.rotation.z = x > 0 ? -0.3 : 0.3;
    }
    const glass = w.ball(g, 0.28, "#6dbbd7", 0, 2.9, -0.02, 2);
    glass.scale.z = 0.28;
    box(0.16, 3.1, 0.16, c, -1.4, 2.2, -0.9);
    box(1.3, 0.14, 0.16, c, -0.83, 3.7, -0.9);
    height = 5.5;
  } else if (s.id === "castle") {
    box(2.8, 1.9, 1.7, "#d5c5cc", 0, 1.55, -0.9);
    for (const x of [-1.4, 1.4]) {
      cyl(0.66, 0.72, 2.8, "#dfd2ce", x, 1.95, -0.65, 10);
      cyl(0, 0.91, 1.15, c, x, 3.9, -0.65, 10);
      box(0.04, 0.8, 0.04, "#826d80", x, 4.65, -0.65);
      box(0.5, 0.3, 0.035, "#f0bd75", x + 0.23, 4.85, -0.65);
      window(x, 2.2, 0.02);
    }
    for (const x of [-0.9, -0.3, 0.3, 0.9]) box(0.34, 0.4, 0.4, "#d5c5cc", x, 2.65, -0.1);
    box(0.75, 1.15, 0.1, "#5e546a", 0, 1.15, -0.02);
    height = 5.5;
  } else {
    box(2.9, 1.9, 2.1, "#f2d4bc", -0.5, 1.6, -0.8);
    const lid = box(3.4, 0.22, 2.5, c, -0.5, 2.8, -0.8);
    lid.rotation.z = 0.2;
    box(2.1, 1.1, 0.07, "#7199a8", -0.5, 1.8, 0.29);
    for (const x of [-1.3, -0.5, 0.3]) box(0.06, 1.3, 0.1, "#ead8bf", x, 1.8, 0.35);
    cyl(0.55, 0.55, 0.55, "#e2d4c3", 1.55, 0.9, -0.45);
    const sculpture = w.ball(g, 0.7, c, 1.55, 1.8, -0.45, 0);
    sculpture.rotation.z = 0.5;
    w.ring(g, 0.6, 0.11, "#f1be78", 1.55, 2.2, -0.45).rotation.x = 0.45;
    height = 4;
  }
  w.terminal(g, -0.65, 1.05, s.color);
  v.robots.push(w.robot(g, -0.65, 2, 0.72));
  cyl(0.38, 0.42, 0.14, c, 1.3, 0.6, 1.6);
  w.box(g, 0.45, 0.42, 0.45, "#d9e9dd", 1.3, 0.87, 1.6);
  v.halo = w.ring(g, 0.44, 0.035, "#76f5d2", 1.3, 0.68, 1.6, 0.6);
  v.anchor.y = height;
}
