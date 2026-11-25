// Prevent flow lines from crossing unrelated areas or ending on a region instead of its actual task node.
import test from "node:test";
import assert from "node:assert/strict";
import { createWireRouter, segmentHits, smoothWire } from "../src/workbench-wires.mjs";

test("open space uses a curve; a blocking card forces a route around it", () => {
  const nodes = { a: box(0, 0, 80, 50), b: box(200, 80, 80, 50) };
  assert.match(
    smoothWire("a", "b", nodes, [], () => []),
    /C/,
  );
  assert.equal(
    smoothWire("a", "b", { ...nodes, block: box(100, 0, 60, 160) }, [], () => []),
    "",
  );
});

const box = (x, y, width, height) => ({ left: x, top: y, right: x + width, bottom: y + height });
test("wires reach specific project and model cards without crossing intervening regions", () => {
  const regions = { projects: box(0, 0, 200, 300), messages: box(230, 0, 200, 300), models: box(460, 0, 240, 300) };
  const nodes = {
    project: { ...box(16, 90, 168, 60), region: "projects" },
    simple: { ...box(476, 60, 96, 60), region: "models" },
    complex: { ...box(588, 60, 96, 60), region: "models" },
  };
  const route = createWireRouter({ nodes, regions, headers: [], width: 700, height: 300 });
  for (const model of ["simple", "complex"]) {
    const points = route("project", model);
    assert.ok(points.length >= 2);
    for (let i = 1; i < points.length; i++) {
      assert.equal(segmentHits(points[i - 1], points[i], regions.messages), false);
      assert.equal(segmentHits(points[i - 1], points[i], nodes[model === "simple" ? "complex" : "simple"]), false);
    }
    const end = points.at(-1),
      card = nodes[model];
    assert.ok(end.x >= card.left && end.x <= card.right && end.y >= card.top && end.y <= card.bottom);
    assert.ok(end.x === card.left || end.x === card.right || end.y === card.top || end.y === card.bottom);
  }
});

test("a vertical execution-to-result wire bypasses the queue instead of implying a return to it", () => {
  const regions = { models: box(0, 0, 300, 130), queue: box(0, 160, 300, 130), results: box(0, 320, 300, 130) };
  const nodes = {
    execution: { ...box(20, 50, 260, 60), region: "models" },
    result: { ...box(20, 370, 260, 60), region: "results" },
  };
  const route = createWireRouter({ nodes, regions, headers: [box(12, 332, 276, 26)], width: 300, height: 450 });
  const points = route("execution", "result");
  assert.ok(points.length >= 2);
  for (let i = 1; i < points.length; i++) assert.equal(segmentHits(points[i - 1], points[i], regions.queue), false);
});
