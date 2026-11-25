import * as T from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { islandPositions, islandStatus } from "./world-state.mjs";

import { buildProjectIsland } from "./project-buildings.js";
import { islandStyle, providerName } from "./island-presets.mjs";

import { visibleIslandHit } from "./world-hit.mjs";
import { ISLAND_ART } from "./island-art.js";

const COLORS = {
  idle: "#8ce2c4",
  running: "#61f5d0",
  queued: "#87bbff",
  waiting: "#ffc56f",
  paused: "#b7acd7",
  unknown: "#ff8199",
  offline: "#7c8799",
};
const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);

export class IslandWorld {
  constructor(host, onSelect) {
    this.host = host;
    this.onSelect = onSelect;
    this.visuals = new Map();
    this.routes = [];
    this.signature = "";
    this.selected = "";
    this.islands = [];
    this.connected = false;
    this.materials = new Map();
    this.artTextures = new Map();
    this.artMaterials = new Map();
    this.geometries = new Map();
    this.animated = true;
    this.active = true;
    this.available = true;
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)");
    this.renderer = new T.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = T.PCFShadowMap;
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.domElement.setAttribute("aria-label", "插画岛屿世界：拖动平移，滚轮缩放；也可使用岛屿标签选择配置");
    this.renderer.domElement.tabIndex = 0;
    host.append(this.renderer.domElement);
    this.labels = document.createElement("div");
    this.labels.className = "island-labels";
    host.append(this.labels);
    this.scene = new T.Scene();
    this.scene.fog = new T.FogExp2("#1b2538", 0.005);
    this.camera = new T.OrthographicCamera(-20, 20, 15, -15, 0.1, 250);
    this.camera.position.set(24, 29, 37);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enableRotate = false;
    this.controls.touches = { ONE: T.TOUCH.PAN, TWO: T.TOUCH.DOLLY_PAN };
    this.controls.dampingFactor = 0.08;
    this.controls.minZoom = 0.45;
    this.controls.maxZoom = 3.8;
    this.controls.minPolarAngle = 0.25;
    this.controls.maxPolarAngle = 1.25;
    this.controls.target.set(0, 0, 0);
    this.controls.mouseButtons = { LEFT: T.MOUSE.PAN, MIDDLE: T.MOUSE.DOLLY, RIGHT: T.MOUSE.PAN };
    const ambient = new T.HemisphereLight("#dfecff", "#7c8197", 1.05);
    this.scene.add(ambient);
    const sun = new T.DirectionalLight("#fff2da", 2.4);
    sun.position.set(-12, 25, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -40, right: 30, top: 35, bottom: -30, near: 1, far: 90 });
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.06;
    this.scene.add(sun);
    const fill = new T.DirectionalLight("#afa4ff", 0.85);
    fill.position.set(10, 6, -14);
    this.scene.add(fill);
    const env = new RoomEnvironment();
    const pmrem = new T.PMREMGenerator(this.renderer);
    this.environment = pmrem.fromScene(env, 0.06);
    this.scene.environment = this.environment.texture;
    this.scene.environmentIntensity = 0.3;
    env.dispose();
    pmrem.dispose();
    this.content = new T.Group();
    this.scene.add(this.content);
    this.ray = new T.Raycaster();
    this.pointer = new T.Vector2();
    this.down = null;
    this.renderer.domElement.addEventListener("pointerdown", (e) => (this.down = { x: e.clientX, y: e.clientY }));
    this.renderer.domElement.addEventListener("pointerup", (e) => {
      if (!this.down || Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 6) return;
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, (-(e.clientY - rect.top) / rect.height) * 2 + 1);
      this.ray.setFromCamera(this.pointer, this.camera);
      const hit = this.ray.intersectObject(this.content, true).find(visibleIslandHit);
      if (hit) this.onSelect(hit.object.userData.island);
    });
    this.renderer.domElement.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      host.classList.add("world-unavailable");
      host.dataset.error = "三维显示已暂停，请刷新页面恢复；仍可通过岛屿目录配置。";
      this.active = false;
      this.available = false;
    });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.frame = this.frame.bind(this);
    this.lastFrame = 0;
    this.raf = requestAnimationFrame(this.frame);
  }
  mat(color, emission = 0, transparent = false) {
    const key = [color, emission, transparent].join("/");
    if (!this.materials.has(key))
      this.materials.set(
        key,
        new T.MeshStandardMaterial({
          color,
          roughness: 0.64,
          metalness: 0.08,
          emissive: color,
          emissiveIntensity: emission,
          transparent,
          opacity: transparent ? 0.25 : 1,
          depthWrite: !transparent,
        }),
      );
    return this.materials.get(key);
  }
  geo(key, build) {
    if (!this.geometries.has(key)) this.geometries.set(key, build());
    return this.geometries.get(key);
  }
  mesh(parent, geometry, material, x = 0, y = 0, z = 0) {
    const mesh = new T.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }
  box(parent, w, h, d, color, x = 0, y = 0, z = 0, round = 0.08, glow = 0) {
    return this.mesh(
      parent,
      this.geo(`b${w},${h},${d},${round}`, () =>
        round ? new RoundedBoxGeometry(w, h, d, 2, Math.min(round, w / 3, h / 3, d / 3)) : new T.BoxGeometry(w, h, d),
      ),
      this.mat(color, glow),
      x,
      y,
      z,
    );
  }
  cylinder(parent, top, bottom, height, color, x = 0, y = 0, z = 0, sides = 32, glow = 0) {
    return this.mesh(
      parent,
      this.geo(`c${top},${bottom},${height},${sides}`, () => new T.CylinderGeometry(top, bottom, height, sides)),
      this.mat(color, glow),
      x,
      y,
      z,
    );
  }
  ball(parent, r, color, x = 0, y = 0, z = 0, detail = 1, glow = 0) {
    return this.mesh(
      parent,
      this.geo(`s${r},${detail}`, () => new T.IcosahedronGeometry(r, detail)),
      this.mat(color, glow),
      x,
      y,
      z,
    );
  }
  ring(parent, r, tube, color, x = 0, y = 0, z = 0, glow = 0) {
    const m = this.mesh(
      parent,
      this.geo(`r${r},${tube}`, () => new T.TorusGeometry(r, tube, 6, 72)),
      this.mat(color, glow),
      x,
      y,
      z,
    );
    m.rotation.x = -Math.PI / 2;
    return m;
  }
  tree(parent, x, z, scale = 1, pink = false) {
    const g = new T.Group();
    g.position.set(x, 0.25, z);
    g.scale.setScalar(scale);
    parent.add(g);
    this.cylinder(g, 0.09, 0.14, 1.1, "#88755f", 0, 0.5, 0, 7);
    const colors = pink ? ["#eec3dc", "#dc9fc9", "#f6d6e7"] : ["#8cb87c", "#6a9c76", "#accb85"];
    this.ball(g, 0.65, colors[0], 0, 1.38, 0);
    this.ball(g, 0.43, colors[1], -0.35, 1.1, 0.12);
    this.ball(g, 0.47, colors[2], 0.26, 1.53, 0.02);
  }
  plant(parent, x, z, seed = 0) {
    this.ball(parent, 0.17, "#8ab585", x, 0.35, z, 0);
    if (seed % 2 === 0) {
      this.ball(parent, 0.08, seed % 3 ? "#edd7f3" : "#ffdfad", x + 0.1, 0.52, z, 0);
      this.ball(parent, 0.055, "#fcf0ca", x - 0.12, 0.49, z + 0.1, 0);
    }
  }
  islandBase(x, z, r, key, color) {
    const g = new T.Group();
    g.position.set(x, 0, z);
    this.content.add(g);
    this.cylinder(g, r * 0.87, r * 0.49, 1.6, "#696b86", 0, -1, 0, 9);
    this.cylinder(g, r * 0.5, r * 0.08, 1.6, "#565c78", 0.25, -2.45, -0.08, 7);
    this.cylinder(g, r, r * 0.9, 0.5, "#b7b3b2", 0, -0.06, 0, 14);
    this.cylinder(g, r * 0.97, r * 0.97, 0.16, "#79a077", 0, 0.23, 0, 48);
    this.cylinder(g, r * 0.83, r * 0.84, 0.16, "#e9ddc7", 0, 0.34, 0, 48);
    this.cylinder(g, r * 0.75, r * 0.76, 0.06, "#e3d1b5", 0, 0.44, 0, 48);
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const tile = this.box(g, 0.29, 0.07, 0.33, "#f3e7d4", Math.cos(a) * r * 0.8, 0.48, Math.sin(a) * r * 0.8, 0.02);
      tile.rotation.y = -a;
    }
    for (let i = 0; i < 9; i++) {
      const a = i * 2.4 + 0.35;
      this.plant(g, Math.cos(a) * r * 0.9, Math.sin(a) * r * 0.9, i);
      if (i % 3 === 0) this.tree(g, Math.cos(a) * r * 0.87, Math.sin(a) * r * 0.87, 0.65 + (i % 2) * 0.2, i === 3);
      this.ball(g, 0.3, "#8a8a9c", Math.cos(a) * r * 0.84, -0.52 - (i % 3) * 0.25, Math.sin(a) * r * 0.84, 0);
    }
    // Small pond and falling water make the terrain read as an island, rather than a platform.
    const pond = this.ball(g, 0.7, "#65c2c5", r * 0.49, 0.42, r * 0.47, 2, 0.06);
    pond.scale.set(1, 0.06, 0.72);
    const waterfall = this.box(g, 0.36, 2.1, 0.06, "#8edcda", r * 0.7, -0.55, r * 0.58, 0.02, 0.1);
    waterfall.rotation.y = -0.55;
    for (let i = 0; i < 3; i++) {
      const stream = this.box(
        g,
        0.026,
        1.6 - i * 0.14,
        0.015,
        "#d9f9e9",
        r * 0.7 + (i - 1) * 0.08,
        -0.5,
        r * 0.58 + 0.05,
        0.006,
        0.15,
      );
      stream.rotation.y = -0.55;
    }
    const highlight = this.ring(g, r * 0.97, 0.035, color, 0, 0.36, 0, 0.6);
    highlight.visible = false;
    g.userData.key = key;
    const label = document.createElement("button");
    label.type = "button";
    label.className = "island-label";
    label.addEventListener("click", () => this.onSelect(key));
    this.labels.append(label);
    const visual = {
      group: g,
      highlight,
      label,
      anchor: V(x, 4.3, z),
      key,
      robots: [],
      halo: null,
      light: null,
      cargo: [],
    };
    this.visuals.set(key, visual);
    return visual;
  }
  robot(parent, x, z, scale = 1) {
    const root = new T.Group();
    root.position.set(x, 0.48, z);
    root.scale.setScalar(scale);
    parent.add(root);
    this.box(root, 0.53, 0.52, 0.4, "#eef0e8", 0, 0.46, 0, 0.18);
    this.box(root, 0.76, 0.58, 0.56, "#f5f1e8", 0, 1.02, 0, 0.22);
    this.box(root, 0.62, 0.36, 0.09, "#253e50", 0, 1.04, 0.265, 0.13);
    const eye1 = this.ball(root, 0.055, "#68f3e3", -0.17, 1.07, 0.322, 2, 1.2);
    const eye2 = this.ball(root, 0.055, "#68f3e3", 0.17, 1.07, 0.322, 2, 1.2);
    this.box(root, 0.18, 0.18, 0.29, "#777f94", -0.17, 0.12, 0.02, 0.065);
    this.box(root, 0.18, 0.18, 0.29, "#777f94", 0.17, 0.12, 0.02, 0.065);
    this.ball(root, 0.09, "#77bdb8", 0, 0.5, 0.23, 1, 0.5);
    this.cylinder(root, 0.025, 0.025, 0.15, "#8a94a2", 0, 1.36, 0, 8);
    this.ball(root, 0.055, "#ffd39e", 0, 1.46, 0, 1, 0.5);
    const arms = [];
    for (const side of [-1, 1]) {
      const arm = new T.Group();
      arm.position.set(side * 0.35, 0.68, 0);
      root.add(arm);
      this.box(arm, 0.14, 0.35, 0.16, "#eceae2", 0, -0.13, 0.05, 0.06);
      this.ball(arm, 0.09, "#a5aabd", 0, -0.3, 0.07, 1);
      arms.push(arm);
    }
    return { root, arms, eyes: [eye1, eye2], baseY: root.position.y };
  }
  terminal(parent, x, z, color = "#83ddce") {
    this.box(parent, 1.25, 0.12, 0.65, "#d1c8b7", x, 1.1, z, 0.05);
    this.box(parent, 0.1, 0.63, 0.4, "#a7a6b0", x, 0.76, z, 0.025);
    this.box(parent, 0.9, 0.6, 0.08, "#334f62", x, 1.55, z - 0.23, 0.06);
    this.box(parent, 0.77, 0.46, 0.02, color, x, 1.55, z - 0.176, 0.02, 0.25);
    for (let i = 0; i < 4; i++)
      this.box(
        parent,
        0.18 + (i % 3) * 0.15,
        0.018,
        0.012,
        "#234e65",
        x - 0.13 + (i % 2) * 0.1,
        1.68 - i * 0.08,
        z - 0.158,
        0.003,
      );
    this.box(parent, 0.55, 0.035, 0.19, "#91a3af", x, 1.19, z + 0.08, 0.02);
  }
  workshop(v, color) {
    const g = v.group;
    this.box(g, 4.25, 0.25, 3.05, "#fff0d8", 0, 0.61, -0.25, 0.15);
    this.box(g, 4.1, 1.95, 0.26, "#ecdfcb", 0, 1.67, -1.48, 0.08);
    for (const x of [-1.92, 1.92]) this.box(g, 0.28, 2.1, 2.7, "#efe5d2", x, 1.73, -0.25, 0.11);
    // The front and central roof stay open, exposing the working agent and tools.
    this.box(g, 4.5, 0.34, 1.38, color, 0, 2.8, -1.04, 0.16);
    this.box(g, 0.3, 0.3, 2.9, color, -2.03, 2.78, -0.25, 0.1);
    this.box(g, 0.3, 0.3, 2.9, color, 2.03, 2.78, -0.25, 0.1);
    this.box(g, 4.2, 0.07, 0.08, "#ffe0aa", 0, 2.56, -0.32, 0.02, 0.8);
    this.box(g, 3.1, 0.08, 0.08, "#ffdfae", 0, 0.79, 1.26, 0.015, 0.6);
    for (const x of [-1.1, 0, 1.1]) {
      this.box(g, 0.74, 1.16, 0.05, "#607e99", x, 1.72, -1.319, 0.03);
      this.box(g, 0.64, 1.03, 0.025, "#92bfc6", x, 1.74, -1.278, 0.025);
    }
    this.terminal(g, -0.65, -0.28);
    const bot = this.robot(g, -0.65, 0.75, 0.85);
    v.robots.push(bot);
    this.box(g, 0.85, 0.95, 0.8, "#d6c8b3", 1.15, 1.05, -0.3, 0.1);
    for (let row = 0; row < 3; row++) this.box(g, 0.65, 0.04, 0.58, "#8b91a8", 1.15, 0.8 + row * 0.24, -0.27, 0.015);
    for (let row = 0; row < 3; row++)
      for (let b = 0; b < 3; b++)
        this.box(
          g,
          0.12,
          0.14,
          0.3,
          ["#a3bbc9", "#dac2d8", "#99cabb"][b],
          0.92 + b * 0.2,
          0.91 + row * 0.24,
          -0.17,
          0.02,
        );
    this.cylinder(g, 0.44, 0.48, 0.15, color, 1.3, 0.56, 1.28, 28);
    this.box(g, 0.58, 0.5, 0.58, "#bdece0", 1.3, 0.9, 1.28, 0.08, 0.08);
    const ring = this.ring(g, 0.49, 0.035, "#76f5d2", 1.3, 0.67, 1.28, 0.8);
    v.halo = ring;
    // Front terrace with gentle curved steps.
    for (let i = 0; i < 3; i++)
      this.box(g, 1.5 + i * 0.2, 0.12, 0.32, "#f0dfc3", 0, 0.62 - i * 0.1, 1.42 + i * 0.25, 0.03);
    this.tree(g, -2.4, -0.6, 0.85);
    this.tree(g, 2.4, 0.9, 0.65, true);
    // Terrace lamps, roof trim and a tool bench give each workspace a visible working scale.
    for (const x of [-1.6, 1.6]) {
      this.cylinder(g, 0.04, 0.06, 0.65, "#8e8f9e", x, 0.82, 1.65, 8);
      this.box(g, 0.19, 0.2, 0.19, "#fbe5b4", x, 1.18, 1.65, 0.035, 0.45);
    }
    this.box(g, 0.72, 0.08, 0.45, "#cbbda6", 1.3, 1.43, 0.55, 0.035);
    this.cylinder(g, 0.075, 0.09, 0.35, "#b3a7cf", 1.15, 1.64, 0.55, 12);
    this.ball(g, 0.12, "#91bfc5", 1.15, 1.84, 0.55, 1);
    for (let i = 0; i < 4; i++) this.box(g, 0.23, 0.06, 0.7, "#8f9ec6", -0.65 + i * 0.45, 3.01, -1.04, 0.025);
  }
  hub(v) {
    const g = v.group;
    this.cylinder(g, 2.1, 2.24, 0.22, "#f7e8d4", 0, 0.61, 0, 48);
    this.cylinder(g, 1.9, 2.03, 0.18, "#c9beb1", 0, 0.8, 0, 48);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      this.cylinder(g, 0.1, 0.15, 2.1, "#f4e6ce", Math.cos(a) * 1.92, 1.9, Math.sin(a) * 1.92, 12);
    }
    const dome = this.mesh(
      g,
      this.geo("hub-dome", () => new T.SphereGeometry(2.06, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2)),
      this.mat("#b4e1e9", 0, true),
      0,
      2.86,
      0,
    );
    dome.castShadow = false;
    for (let i = 0; i < 8; i++) {
      const curve = new T.EllipseCurve(0, 0, 2.08, 2.08, 0, Math.PI / 2, false, 0);
      const points = curve.getPoints(24).map((p) => V(p.x, p.y, 0));
      const rail = this.mesh(
        g,
        this.geo("dome-rail", () => new T.TubeGeometry(new T.CatmullRomCurve3(points), 24, 0.035, 6, false)),
        this.mat("#f5dfbc"),
        0,
        2.86,
        0,
      );
      rail.rotation.y = (i * Math.PI) / 4;
    }
    this.ring(g, 2.08, 0.1, "#ecd8bb", 0, 2.86, 0);
    this.ring(g, 2.12, 0.028, "#ffdf9c", 0, 2.7, 0, 0.7);
    this.cylinder(g, 0.83, 0.95, 0.4, "#527486", 0, 1, 0, 40);
    this.ring(g, 0.85, 0.06, "#7df9de", 0, 1.25, 0, 1);
    const core = this.box(g, 0.72, 0.72, 0.72, "#9aead7", 0, 1.9, 0, 0.09, 0.5);
    core.rotation.y = Math.PI / 4;
    v.core = core;
    const halo = this.ring(g, 1.09, 0.025, "#8dffee", 0, 2.12, 0, 1);
    v.halo = halo;
    const robot = this.robot(g, 0.55, 1.5, 0.62);
    v.robots.push(robot);
    this.cylinder(g, 0.12, 0.25, 0.5, "#d1bf9c", 0, 5.05, 0, 16);
    const satellite = this.ring(g, 0.63, 0.045, "#ffdeab", 0, 5.35, 0, 0.6);
    satellite.rotation.z = 0.5;
    v.satellite = satellite;
    this.ball(g, 0.2, "#d2bee5", 0, 5.35, 0, 2);
    for (let i = 0; i < 3; i++)
      this.box(g, 1.8 + i * 0.2, 0.12, 0.34, "#efdfc5", 0, 0.61 - i * 0.1, 2.25 + i * 0.28, 0.03);
    v.anchor.y = 5.6;
  }
  memory(v) {
    const g = v.group;
    this.box(g, 3.6, 0.3, 2.8, "#f2e5d2", 0, 0.63, 0, 0.14);
    this.box(g, 3.45, 2, 0.28, "#e7dcca", 0, 1.73, -1.2, 0.08);
    for (const x of [-1.6, 1.6]) this.box(g, 0.22, 2.1, 2.3, "#eee4d5", x, 1.73, -0.15, 0.1);
    this.box(g, 3.8, 0.38, 1.7, "#abc1d9", 0, 2.96, -0.54, 0.18);
    for (const x of [-1.05, 0, 1.05]) {
      this.box(g, 0.86, 1.5, 0.3, "#9a816e", x, 1.65, -0.94, 0.035);
      for (let row = 0; row < 3; row++) {
        this.box(g, 0.84, 0.06, 0.43, "#e9cfaa", x, 1.19 + row * 0.4, -0.82, 0.02);
        for (let b = 0; b < 4; b++)
          this.box(
            g,
            0.13,
            0.27,
            0.21,
            ["#aec8d0", "#d4b1c7", "#a4b8da", "#ecd4a8"][b],
            x - 0.29 + b * 0.19,
            1.36 + row * 0.4,
            -0.76,
            0.015,
          );
      }
    }
    this.cylinder(g, 0.62, 0.72, 0.18, "#accfce", 0.6, 0.58, 0.78, 28);
    for (let i = 0; i < 3; i++)
      this.box(
        g,
        0.36,
        0.36,
        0.36,
        "#8bd9e3",
        0.45 + (i % 2) * 0.42,
        0.85 + Math.floor(i / 2) * 0.4,
        0.85,
        0.045,
        0.15,
      );
    v.robots.push(this.robot(g, -0.65, 0.75, 0.67));
    this.tree(g, -1.9, -0.6, 0.8, true);
  }
  decision(v) {
    const g = v.group;
    this.cylinder(g, 2, 2.15, 0.25, "#ecd4b4", 0, 0.62, 0, 40);
    this.cylinder(g, 1.75, 1.88, 0.18, "#f2e3cb", 0, 0.83, 0, 40);
    for (const a of [Math.PI, Math.PI * 1.3, Math.PI * 1.7, 0])
      this.cylinder(g, 0.14, 0.18, 1.8, "#eddbbd", Math.cos(a) * 1.7, 1.8, Math.sin(a) * 1.7, 12);
    this.cylinder(g, 1.95, 2.15, 0.3, "#e9bb75", 0, 2.84, 0, 48);
    this.cylinder(g, 1.3, 1.95, 0.47, "#f5d49b", 0, 3.23, 0, 48);
    const beacon = this.cylinder(g, 0.18, 0.24, 0.48, "#ffc166", 0, 3.7, 0, 16, 0.8);
    v.light = beacon;
    this.cylinder(g, 0.4, 0.45, 0.12, "#eee7da", 0, 3.43, 0, 24);
    v.halo = this.ring(g, 1.92, 0.045, "#f6ca79", 0, 0.85, 0, 0.7);
    v.robots.push(this.robot(g, 0.25, 0.65, 0.85));
    for (let i = 0; i < 3; i++) {
      const c = this.box(g, 0.38, 0.38, 0.38, "#f4c878", -0.9 + i * 0.43, 0.98, 1.38, 0.07, 0.1);
      v.cargo.push(c);
    }
    this.tree(g, 2, -0.7, 0.7, true);
  }
  bridge(from, to, key) {
    const a = from.group.position.clone(),
      b = to.group.position.clone();
    const direction = b.clone().sub(a).normalize();
    a.addScaledVector(direction, 2.85);
    b.addScaledVector(direction, -2.5);
    a.y = 0.5;
    b.y = 0.5;
    const middle = a.clone().lerp(b, 0.5);
    middle.y = 0.85;
    const curve = new T.CatmullRomCurve3([a, a.clone().lerp(middle, 0.5), middle, middle.clone().lerp(b, 0.5), b]);
    const route = new T.Group();
    this.content.add(route);
    for (let i = 0; i < 36; i++) {
      const point = curve.getPoint(i / 35);
      const tangent = curve.getTangent(i / 35);
      const segment = this.box(
        route,
        1.02,
        0.16,
        a.distanceTo(b) / 35 + 0.08,
        "#a2a8bd",
        point.x,
        point.y - 0.11,
        point.z,
        0.025,
      );
      segment.rotation.y = Math.atan2(tangent.x, tangent.z);
    }
    for (const side of [-1, 1]) {
      const points = Array.from({ length: 37 }, (_, i) => {
        const p = curve.getPoint(i / 36);
        const d = curve.getTangent(i / 36);
        return p.add(V(d.z * side * 0.39, 0.13, -d.x * side * 0.39));
      });
      const rail = this.mesh(
        route,
        new T.TubeGeometry(new T.CatmullRomCurve3(points), 36, 0.04, 6, false),
        this.mat("#7adacb", 0.6),
      );
      rail.userData.disposableGeometry = true;
      const support = this.mesh(
        route,
        new T.TubeGeometry(
          new T.CatmullRomCurve3(points.map((p) => p.clone().add(V(0, -0.22, 0)))),
          36,
          0.065,
          6,
          false,
        ),
        this.mat("#e5d4bc"),
      );
      support.userData.disposableGeometry = true;
    }
    const carts = [];
    for (let i = 0; i < 3; i++) {
      const cart = new T.Group();
      route.add(cart);
      this.box(cart, 0.55, 0.16, 0.66, "#e9e1d1", 0, 0.12, 0, 0.08);
      this.box(cart, 0.38, 0.38, 0.38, "#9ce7d9", 0, 0.39, 0, 0.055, 0.35);
      for (const x of [-0.25, 0.25])
        for (const z of [-0.21, 0.21]) {
          const w = this.cylinder(cart, 0.09, 0.09, 0.07, "#5b6c80", x, 0.06, z, 12);
          w.rotation.z = Math.PI / 2;
        }
      cart.visible = false;
      carts.push(cart);
    }
    route.traverse((o) => {
      if (o.isMesh) o.userData.island = key;
    });
    this.routes.push({ key, curve, carts, active: 0, queued: 0, waiting: false });
  }
  illustrate(v, id) {
    const url = ISLAND_ART[id];
    if (!url) return;
    let entry = this.artTextures.get(id);
    if (!entry) {
      entry = { ready: false, callbacks: [] };
      this.artTextures.set(id, entry);
      entry.texture = new T.TextureLoader().load(url, (texture) => {
        texture.colorSpace = T.SRGBColorSpace;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 128;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(texture.image, 0, 0, 128, 128);
        entry.hitMask = { size: 128, data: context.getImageData(0, 0, 128, 128).data };
        entry.ready = true;
        entry.callbacks.splice(0).forEach((apply) => apply());
      });
      entry.texture.colorSpace = T.SRGBColorSpace;
      this.artMaterials.set(
        id,
        new T.SpriteMaterial({
          map: entry.texture,
          transparent: true,
          alphaTest: 0.08,
          depthWrite: true,
          toneMapped: false,
        }),
      );
    }
    const fallback = [...v.group.children];
    const sprite = new T.Sprite(this.artMaterials.get(id));
    sprite.center.set(0.5, 0.27);
    sprite.position.set(0, 0.5, 0);
    sprite.visible = false;
    sprite.userData.island = v.key;
    v.group.add(sprite);
    v.art = sprite;
    v.anchor.y = 7.2;
    const apply = () => {
      fallback.forEach((child) => {
        if (child !== v.highlight) child.visible = false;
      });
      const ratio = entry.texture.image.height / entry.texture.image.width;
      sprite.scale.set(8.8, 8.8 * ratio, 1);
      sprite.userData.hitMask = entry.hitMask;
      sprite.visible = true;
    };
    if (entry.ready) apply();
    else entry.callbacks.push(apply);
  }
  build(islands) {
    this.content.traverse((o) => {
      if (o.userData.disposableGeometry) o.geometry.dispose();
    });
    this.content.clear();
    this.labels.replaceChildren();
    this.visuals.clear();
    this.routes = [];
    const hub = this.islandBase(2, 0, 3.5, "hub", "#87edda");
    this.hub(hub);
    this.illustrate(hub, "hub");
    const memory = this.islandBase(
      islands.length <= 2 ? 6.3 : 7,
      islands.length <= 2 ? -13.6 : -7.5,
      2.9,
      "memory",
      "#b4c5ee",
    );
    this.memory(memory);
    this.illustrate(memory, "memory");
    const decision = this.islandBase(
      islands.length <= 2 ? 16.2 : 9,
      islands.length <= 2 ? 1.6 : 5.5,
      2.8,
      "decision",
      "#f5c87f",
    );
    this.decision(decision);
    this.illustrate(decision, "decision");
    for (const [index, p] of islands.entries()) {
      const site = islandPositions(islands)[index];
      const visual = this.islandBase(site.x, site.z, 3.35, "project:" + p.id, p.color || "#c8b5e6");
      buildProjectIsland(this, visual, p.islandStyle);
      this.illustrate(visual, p.islandStyle);
      this.bridge(visual, hub, "project:" + p.id);
    }
    this.bridge(hub, memory, "memory");
    this.bridge(hub, decision, "decision");
    for (const v of this.visuals.values())
      v.group.traverse((o) => {
        if (o.isMesh || o.isSprite) o.userData.island = v.key;
      });
    this.fit();
  }
  update(islands, snapshot) {
    this.islands = islands;
    this.snapshot = snapshot;
    this.connected = snapshot.connected;
    const signature = JSON.stringify(islands.map((i) => [i.id, i.color, i.islandStyle]));
    if (signature !== this.signature) {
      this.signature = signature;
      this.build(islands);
    }
    const n = (snapshot.state?.cards || []).filter((c) => c.kind === "ask").length;
    for (const [key, v] of this.visuals) {
      const project = islands.find((p) => "project:" + p.id === key);
      const status =
        project?.status ||
        (!snapshot.connected
          ? "offline"
          : key === "decision" && n
            ? "waiting"
            : key === "hub" && snapshot.state?.totals?.running
              ? "running"
              : "idle");
      v.status = status;
      v.working =
        snapshot.connected &&
        (project ? project.running.length > 0 : key === "hub" && snapshot.state?.totals?.running > 0);
      const name = project?.name || { hub: "调度中心", memory: "上下文记忆库", decision: "人工决定站" }[key];
      const meta = project
        ? `${islandStyle(project.islandStyle).name} · ${providerName(project.agent)} · ${islandStatus[status]}${project.running.length ? " · " + project.running.length + " 轮" : project.timers.length ? " · 已预约复查" : ""}`
        : key === "decision"
          ? n
            ? `${n} 个决定待处理`
            : "没有待答任务"
          : key === "memory"
            ? `${snapshot.topics?.length || 0} 个话题`
            : `${snapshot.state?.totals?.running || 0} 执行 · ${snapshot.state?.totals?.queued || 0} 排队`;
      if (v.label.dataset.name !== name) {
        v.label.replaceChildren();
        const dot = document.createElement("i"),
          title = document.createElement("b"),
          small = document.createElement("small");
        title.textContent = name;
        v.label.append(dot, title, small);
        v.label.dataset.name = name;
      }
      v.label.querySelector("small").textContent = meta;
      v.label.setAttribute("aria-label", `${name}，${meta}，点击配置`);
      v.label.style.setProperty("--island-color", COLORS[status]);
      v.label.dataset.status = status;
      if (v.halo) v.halo.material = this.mat(COLORS[status], status === "offline" ? 0 : 0.6);
      for (const bot of v.robots) for (const eye of bot.eyes) eye.material = this.mat(COLORS[status], 0.8);
      if (key === "decision") v.cargo.forEach((c, i) => (c.visible = snapshot.connected && i < n));
    }
    for (const route of this.routes) {
      const project = islands.find((p) => "project:" + p.id === route.key);
      route.active = snapshot.connected ? project?.running.length || 0 : 0;
      route.queued = snapshot.connected ? project?.queued.length || 0 : 0;
      route.waiting = route.key === "decision" && snapshot.connected && n > 0;
      if (route.key === "memory")
        route.active = snapshot.connected
          ? islands.reduce((sum, p) => sum + (p.rule?.resume ? p.running.length : 0), 0)
          : 0;
      route.carts.forEach(
        (c, i) =>
          (c.visible = route.active
            ? i < Math.min(route.active, 3)
            : route.queued
              ? i < Math.min(route.queued, 3)
              : route.waiting
                ? i < Math.min(n, 3)
                : false),
      );
    }
    this.select(this.selected);
  }
  select(id) {
    this.selected = id;
    for (const [key, v] of this.visuals) {
      v.highlight.visible = key === id;
      v.label.classList.toggle("selected", key === id);
    }
  }
  focus(id) {
    const v = this.visuals.get(id);
    if (!v) return;
    const next = v.group.position.clone().add(V(0, 1, 0));
    const delta = next.clone().sub(this.controls.target);
    this.camera.position.add(delta);
    this.controls.target.copy(next);
    this.camera.zoom = 1.55;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }
  fit() {
    const sites = [...this.visuals.values()].map((v) => v.group.position);
    if (!sites.length) return;
    const bounds = new T.Box3().setFromPoints(sites);
    bounds.expandByVector(V(4.3, 5.8, 4.3));
    const center = bounds.getCenter(new T.Vector3());
    center.y = 0.3;
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(V(24, 29, 37));
    this.camera.lookAt(center);
    this.camera.updateMatrixWorld();
    const projected = [];
    for (const v of this.visuals.values()) {
      const p = v.group.position;
      if (v.art) {
        const center = p
          .clone()
          .add(V(0, 0.5, 0))
          .applyMatrix4(this.camera.matrixWorldInverse);
        for (const x of [-4.4, 4.4]) for (const y of [-2.4, 6.45]) projected.push(center.clone().add(V(x, y, 0)));
      } else
        for (let i = 0; i < 12; i++)
          for (const y of [-3.1, 3.5]) {
            const a = (i * Math.PI) / 6;
            projected.push(
              V(p.x + Math.cos(a) * 3.5, y, p.z + Math.sin(a) * 3.5).applyMatrix4(this.camera.matrixWorldInverse),
            );
          }
      projected.push(
        v.anchor
          .clone()
          .add(V(0, 1, 0))
          .applyMatrix4(this.camera.matrixWorldInverse),
      );
    }
    const box = new T.Box3().setFromPoints(projected),
      size = box.getSize(V()),
      offset = box.getCenter(V());
    const shift = V(offset.x, offset.y, 0).applyQuaternion(this.camera.quaternion);
    this.camera.position.add(shift);
    this.controls.target.add(shift);
    this.fitWidth = size.x * 1.08;
    this.fitHeight = size.y * 1.08;
    this.camera.zoom = 1;
    this.resize();
    this.controls.update();
  }
  resize() {
    const width = this.host.clientWidth,
      height = this.host.clientHeight;
    if (!width || !height) return;
    this.renderer.setSize(width, height);
    const aspect = width / height;
    const topPadding = Math.min(118, height * 0.16),
      bottomPadding = Math.min(98, height * 0.14);
    const usableHeight = height - topPadding - bottomPadding;
    const half = Math.max((((this.fitHeight || 25) / 2) * height) / usableHeight, (this.fitWidth || 38) / 2 / aspect);
    const offset = ((topPadding - bottomPadding) * half) / height;
    Object.assign(this.camera, {
      left: -half * aspect,
      right: half * aspect,
      top: half + offset,
      bottom: -half + offset,
    });
    this.camera.updateProjectionMatrix();
  }
  zoomBy(delta) {
    this.camera.zoom = T.MathUtils.clamp(this.camera.zoom + delta, 0.45, 3.8);
    this.camera.updateProjectionMatrix();
  }
  follow() {
    const project = this.islands.find((p) => p.running.length);
    if (project) {
      this.onSelect("project:" + project.id);
      this.focus("project:" + project.id);
      return true;
    }
    return false;
  }
  frame(now) {
    this.raf = requestAnimationFrame(this.frame);
    if (document.hidden || !this.active || !this.available || now - this.lastFrame < 32) return;
    this.lastFrame = now;
    const t = now / 1000;
    this.controls.update();
    const moving = this.animated && !this.reduced.matches;
    for (const v of this.visuals.values()) {
      const working = v.working && moving;
      for (const [i, bot] of v.robots.entries()) {
        bot.root.position.y = bot.baseY + (working ? Math.sin(t * 3 + i) * 0.045 : 0);
        bot.root.rotation.z = working ? Math.sin(t * 2) * 0.025 : 0;
        bot.arms.forEach((arm, n) => (arm.rotation.x = working ? -0.7 + Math.sin(t * 7 + n * Math.PI) * 0.35 : 0));
      }
      if (v.core) {
        v.core.rotation.y = moving && this.connected ? t * 0.35 : Math.PI / 4;
        v.core.position.y = 1.9 + (working ? Math.sin(t * 2) * 0.08 : 0);
      }
      if (v.light)
        v.light.material = this.mat(v.status === "waiting" ? "#ffc56f" : "#9a9ba3", v.status === "waiting" ? 0.8 : 0);
      const projected = v.anchor.clone().project(this.camera);
      const x = (projected.x * 0.5 + 0.5) * this.host.clientWidth,
        y = (-projected.y * 0.5 + 0.5) * this.host.clientHeight;
      v.label.style.transform = `translate(${x}px,${y}px) translate(-50%,-100%)`;
      v.label.hidden =
        projected.z > 1 ||
        projected.z < -1 ||
        x < -100 ||
        x > this.host.clientWidth + 100 ||
        y < -60 ||
        y > this.host.clientHeight + 60;
    }
    for (const route of this.routes)
      route.carts.forEach((cart, i) => {
        if (!cart.visible) return;
        const progress =
          route.active && moving ? (t * 0.1 + i * 0.29) % 1 : route.waiting ? 0.8 - i * 0.11 : 0.15 + i * 0.13;
        cart.position.copy(route.curve.getPoint(progress)).add(V(0, 0.08, 0));
        const tangent = route.curve.getTangent(progress);
        cart.rotation.y = Math.atan2(tangent.x, tangent.z);
      });
    this.renderer.render(this.scene, this.camera);
  }
  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    for (const entry of this.artTextures.values()) entry.texture.dispose();
    for (const material of this.artMaterials.values()) material.dispose();
    this.controls.dispose();
    this.content.traverse((o) => {
      if (o.userData.disposableGeometry) o.geometry.dispose();
    });
    this.geometries.forEach((g) => g.dispose());
    this.materials.forEach((m) => m.dispose());
    this.environment.dispose();
    this.renderer.dispose();
    this.host.replaceChildren();
  }
}
