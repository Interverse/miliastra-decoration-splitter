// Shared reparenting math for both formats.
//
// The transform hierarchy was reverse-engineered and verified bit-exact
// against game-authored .gil reference files (tools/test-gil.mjs):
//
//   worldPos   = parentPos + parentRot × (parentScale ⊙ localPos)
//   worldRot   = parentRot ∘ localRot     (Euler degrees, Unity Z-X-Y order)
//   worldScale = parentScale ⊙ localScale (component-wise; scale multiplies
//                decoration POSITION as well as size, the S⊙p term above)
//
// .gia files serialize the very same transform component ({1: pos, 2: rot,
// 3: scale/zoom, 501: 0xffffffff sentinel} with zero-omitted float32 vec3s
// as seen in the reference dumps), so the identical composition applies to both
// formats. There are no pivot/origin offset fields at this level: the .gil
// extraction round-trips bit-exact against game output without any.
//
// This module supplies the INVERSE: given a decoration's world transform and
// a new parent, the local transform that reproduces the same world placement
// under that parent. The forward composition is re-exported verbatim from
// the verified engine, never reimplemented.

import {
  quatFromEuler,
  quatMul,
  quatRotate,
  eulerFromQuat,
  composeTransforms,
  makeParentComposer,
} from './gil/split.js';

export { composeTransforms, makeParentComposer };

export const IDENTITY_TRANSFORM = Object.freeze({
  pos: Object.freeze({ x: 0, y: 0, z: 0 }),
  rot: Object.freeze({ x: 0, y: 0, z: 0 }),
  scale: Object.freeze({ x: 1, y: 1, z: 1 }),
});

const isIdentityRot = (e) => e.x % 360 === 0 && e.y % 360 === 0 && e.z % 360 === 0;

/**
 * The local transform under `parent` that composes back to `world`:
 * composeTransforms(parent, decomposeToParent(world, parent)) ≈ world.
 * Inverse of the verified composition: subtract the parent position, rotate
 * by the inverse parent rotation, divide by the parent scale (component-wise;
 * zero components, i.e. degenerate parents, map to 0 instead of Infinity).
 */
export function decomposeToParent(world, parent) {
  const pp = parent.pos;
  const ps = parent.scale;
  const d = { x: world.pos.x - pp.x, y: world.pos.y - pp.y, z: world.pos.z - pp.z };
  let r = d;
  let rot = world.rot;
  if (!isIdentityRot(parent.rot)) {
    const q = quatFromEuler(parent.rot);
    const inv = { x: -q.x, y: -q.y, z: -q.z, w: q.w };
    r = quatRotate(inv, d);
    rot = eulerFromQuat(quatMul(inv, quatFromEuler(world.rot)));
  }
  const div = (a, b) => (Math.abs(b) < 1e-12 ? 0 : a / b);
  return {
    pos: { x: div(r.x, ps.x), y: div(r.y, ps.y), z: div(r.z, ps.z) },
    rot,
    scale: {
      x: div(world.scale.x, ps.x),
      y: div(world.scale.y, ps.y),
      z: div(world.scale.z, ps.z),
    },
  };
}

// Equality at float32 storage precision: the file stores float32, so two
// transforms that round to the same float32 components serialize identically.
const fr = Math.fround;
const vecEq = (a, b) => fr(a.x) === fr(b.x) && fr(a.y) === fr(b.y) && fr(a.z) === fr(b.z);
export const transformEq = (a, b) =>
  vecEq(a.pos, b.pos) && vecEq(a.rot, b.rot) && vecEq(a.scale, b.scale);

/**
 * New local transform for a decoration moving from one parent to another so
 * its world placement is preserved, or null when the stored transform can
 * stay untouched (identical parent transforms, or the recomputed local lands
 * on the same float32 values, the byte-preserving fast path). Null parents
 * (objects without a transform component) count as identity.
 */
export function reparentLocal(local, fromParent, toParent) {
  const from = fromParent ?? IDENTITY_TRANSFORM;
  const to = toParent ?? IDENTITY_TRANSFORM;
  if (transformEq(from, to)) return null;
  const world = composeTransforms(from, local);
  const next = decomposeToParent(world, to);
  if (transformEq(next, local)) return null;
  return next;
}
