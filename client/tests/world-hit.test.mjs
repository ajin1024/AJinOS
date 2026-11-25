// Hidden fallback geometry and transparent illustration corners must not intercept visible islands.
import test from "node:test";
import assert from "node:assert/strict";
import { visibleIslandHit } from "../src/world-hit.mjs";
test("hidden ancestors and transparent sprite pixels do not intercept island clicks", () => {
  const hidden = { visible: false, parent: null };
  assert.equal(visibleIslandHit({ object: { visible: true, userData: { island: "wrong" }, parent: hidden } }), false);
  const mask = { size: 2, data: new Uint8ClampedArray(16) };
  mask.data[3] = 255;
  const sprite = { visible: true, isSprite: true, parent: null, userData: { island: "island", hitMask: mask } };
  assert.equal(visibleIslandHit({ object: sprite, uv: { x: 0.25, y: 0.75 } }), true);
  assert.equal(visibleIslandHit({ object: sprite, uv: { x: 0.75, y: 0.25 } }), false);
});
