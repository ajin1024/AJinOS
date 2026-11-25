// Three's raycaster includes invisible ancestors and transparent areas of sprites.
export function visibleIslandHit(hit) {
  if (!hit.object.userData.island) return false;
  for (let node = hit.object; node; node = node.parent) if (!node.visible) return false;
  if (!hit.object.isSprite) return true;
  const mask = hit.object.userData.hitMask;
  if (!mask || !hit.uv) return false;
  const x = Math.max(0, Math.min(mask.size - 1, Math.floor(hit.uv.x * mask.size)));
  const y = Math.max(0, Math.min(mask.size - 1, Math.floor((1 - hit.uv.y) * mask.size)));
  return mask.data[(y * mask.size + x) * 4 + 3] > 20;
}
