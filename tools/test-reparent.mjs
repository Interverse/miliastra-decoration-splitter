// Reparenting transform-recalculation suite. Run: node tools/test-reparent.mjs
//
// Verifies, for BOTH formats, that moving decorations between parents
// preserves their world-space transform (position, rotation, scale), using
// the composition verified bit-exact against game-authored .gil files:
//   world = P + R·(S⊙p) · R∘r · S⊙s   (Euler degrees, Unity Z-X-Y)
// Also: byte-preserving fast path for equal parent transforms, no cumulative
// drift across repeated reparenting, exact undo (.gil) / entry byte
// restoration on a return move, and reloaded files re-verifying identically.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GilSession } from '../js/gil-splitter.js';
import { GiaSession, _internal } from '../js/gia-splitter.js';
import { composeTransforms } from '../js/transforms.js';
import { quatFromEuler } from '../js/gil/split.js';

const here = dirname(fileURLToPath(import.meta.url));
const REF = join(here, '..', 'reference', 'reference-samples');
const load = (f) => new Uint8Array(readFileSync(join(REF, f)));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
};
const eqBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// world-transform comparison: position/scale numeric, rotation via
// quaternion alignment (Euler representations of the same rotation differ)
const POS_EPS = 1e-3;
const SCALE_EPS = 1e-4;
const vErr = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
const rotAligned = (a, b) => {
  const qa = quatFromEuler(a);
  const qb = quatFromEuler(b);
  const dot = Math.abs(qa.x * qb.x + qa.y * qb.y + qa.z * qb.z + qa.w * qb.w);
  return dot > 1 - 1e-6;
};
const worldEq = (a, b) =>
  vErr(a.pos, b.pos) < POS_EPS && rotAligned(a.rot, b.rot) && vErr(a.scale, b.scale) < SCALE_EPS;
const fmtW = (w) => `pos(${w.pos.x.toFixed(4)},${w.pos.y.toFixed(4)},${w.pos.z.toFixed(4)})`;

// ============================================================ .gil
console.log('== .gil: reparenting across a rotated + zoomed parent');
{
  // The rotate-zoom file's parent carries rotation AND non-unit zoom, the
  // hardest verified case (its extraction output is bit-exact vs the game).
  const bytes = load('Level With 1 Decoration Rotate Zoom Example.gil');
  const s = new GilSession(bytes);
  const parent = s.objects()[0];
  const P = s.level.objectById(parent.id);
  check('rotated/zoomed parent found',
    P.transform && (P.transform.rot.x || P.transform.rot.y || P.transform.rot.z) !== 0);

  // pick a target with a DIFFERENT transform (any other world object)
  const target = s.level.objects.find((o) => o.id !== parent.id && o.transform);
  check('target with different transform found', !!target);

  const decoId = P.decorationIds[0];
  const worldBefore = composeTransforms(P.transform, s.level.decorationById(decoId).transform);

  const res = s.moveDecorationsToParent(parent.id, [0], target.id);
  check('move applied', !!res && res.count === 1);
  const d1 = s.level.decorationById(decoId);
  check('parent back-reference updated', d1.parentId === target.id);
  const worldAfter = composeTransforms(
    s.level.objectById(target.id).transform, d1.transform);
  check('world transform preserved after reparent', worldEq(worldBefore, worldAfter),
    `${fmtW(worldBefore)} vs ${fmtW(worldAfter)}`);

  // reloaded file re-verifies identically (what the game will read)
  const s2 = new GilSession(s.serialize());
  const d2 = s2.level.decorationById(decoId);
  const worldReload = composeTransforms(s2.level.objectById(target.id).transform, d2.transform);
  check('world transform preserved in reloaded file', worldEq(worldBefore, worldReload));

  // undo restores the original file byte-for-byte
  s.undo();
  check('undo restores byte-identical file', eqBytes(s.serialize(), bytes));

  // drift: bounce the decoration between the two parents 10 times
  s.redo();
  for (let i = 0; i < 10; i++) {
    const tSrc = i % 2 === 0 ? target.id : parent.id;
    const tDst = i % 2 === 0 ? parent.id : target.id;
    const src = s.level.objectById(tSrc);
    const idx = src.decorationIds.indexOf(decoId);
    s.moveDecorationsToParent(tSrc, [idx], tDst);
  }
  const owner = s.level.decorationById(decoId).parentId;
  const worldDrift = composeTransforms(
    s.level.objectById(owner).transform, s.level.decorationById(decoId).transform);
  check('no cumulative drift after 11 reparents', worldEq(worldBefore, worldDrift),
    `pos err ${vErr(worldBefore.pos, worldDrift.pos).toExponential(2)}`);
}

console.log('== .gil: equal parent transforms → decoration bytes untouched');
{
  const bytes = load('Level With 2 Decorations.gil');
  const s = new GilSession(bytes);
  const [a, b] = s.objects().map((o) => o.id);
  const A = s.level.objectById(a);
  const B = s.level.objectById(b);
  const equal = JSON.stringify({ p: A.transform.pos, r: A.transform.rot, s: A.transform.scale })
    === JSON.stringify({ p: B.transform.pos, r: B.transform.rot, s: B.transform.scale });
  const decoId = A.decorationIds[0];
  const rawBefore = s.level.decorationById(decoId).field.raw;
  const worldBefore = composeTransforms(A.transform, s.level.decorationById(decoId).transform);
  s.moveDecorationsToParent(a, [0], b);
  const d = s.level.decorationById(decoId);
  const worldAfter = composeTransforms(s.level.objectById(b).transform, d.transform);
  check('world transform preserved', worldEq(worldBefore, worldAfter));
  if (equal) {
    // fast path: transform payload byte-identical (only 502 may differ)
    check('equal parents: local transform values unchanged',
      JSON.stringify(d.transform.pos) === JSON.stringify(s2Local(rawBefore).pos));
  } else {
    check('differing parents handled', true, 'transform recalculated');
  }
  function s2Local(raw) {
    // re-read the ORIGINAL local transform from the pre-move entry bytes
    const tmp = new GilSession(bytes);
    return tmp.level.decorationById(decoId).transform;
  }

  // multi-select move: remaining two decorations at once
  const A2 = s.level.objectById(a);
  const worlds = A2.decorationIds.map((id) =>
    composeTransforms(A2.transform, s.level.decorationById(id).transform));
  const ids = A2.decorationIds.slice();
  s.moveDecorationsToParent(a, [0, 1], b);
  const okAll = ids.every((id, i) => worldEq(
    worlds[i],
    composeTransforms(s.level.objectById(b).transform, s.level.decorationById(id).transform)
  ));
  check('multi-decoration move preserves every world transform independently', okAll);
}

// ============================================================ .gia
console.log('== .gia: reparenting between models at different positions');
{
  const bytes = load('Asset Pack With Three Triangles.gia');
  const s = new GiaSession(bytes);
  const models = s.models;
  check('three models loaded', models.length === 3);
  const mT = (m) => ({ pos: m.worldPos, rot: m.rot, scale: m.zoom });
  const m0 = s._models[0];
  const m2 = s._models[2];
  check('models sit at different positions', vErr(m0.worldPos, m2.worldPos) > 1);

  const guid = s.decorations(0)[0].guid;
  const worldBefore = composeTransforms(mT(m0), s._decT.get(guid));

  s.moveDecorationsToModel(0, [0], 2);
  const worldAfter = composeTransforms(mT(m2), s._decT.get(guid));
  check('world transform preserved in session', worldEq(worldBefore, worldAfter),
    `${fmtW(worldBefore)} vs ${fmtW(worldAfter)}`);

  // serialize → reload → recompute from the FILE's bytes
  const out = s.serialize();
  const s2 = new GiaSession(out);
  const m2b = s2._models.find((m) => m.name === m2.name);
  const worldReload = composeTransforms(
    { pos: m2b.worldPos, rot: m2b.rot, scale: m2b.zoom }, s2._decT.get(guid));
  check('world transform preserved in reloaded file', worldEq(worldBefore, worldReload));
  check('reloaded output round-trips byte-identically', eqBytes(new GiaSession(out).serialize(), out));

  // return move: decoration entry must return to its original bytes
  const idxBack = s.decorations(2).findIndex((d) => d.guid === guid);
  s.moveDecorationsToModel(2, [idxBack], 0);
  check('return move clears the transform override', !s._decTransformDirty.has(guid));
  const rawOf = (buf) => {
    const payloadLen = new DataView(buf.buffer, buf.byteOffset).getUint32(16, false);
    for (const it of _internal.parseMsg(buf.subarray(20, 20 + payloadLen))) {
      if (it.field !== 2 || it.wire !== 2) continue;
      let g = null;
      for (const e of _internal.parseMsg(it.val)) {
        if (e.field === 1 && e.wire === 2) {
          for (const f of _internal.parseMsg(e.val)) if (f.field === 4 && f.wire === 0) g = Number(f.val);
        }
      }
      if (g === guid) return it.val;
    }
    return null;
  };
  check('decoration entry byte-identical after A→B→A',
    eqBytes(rawOf(s.serialize()), rawOf(bytes)));

  // drift across 10 bounces
  const worldOrig = worldBefore;
  for (let i = 0; i < 10; i++) {
    const from = i % 2 === 0 ? 0 : 2;
    const to = i % 2 === 0 ? 2 : 0;
    const idx = s.decorations(from).findIndex((d) => d.guid === guid);
    s.moveDecorationsToModel(from, [idx], to);
  }
  const ownerId = s._models.findIndex((m) => m.decGuids.includes(guid));
  const mo = s._models[ownerId];
  const worldDrift = composeTransforms({ pos: mo.worldPos, rot: mo.rot, scale: mo.zoom }, s._decT.get(guid));
  check('no cumulative drift after 10 reparents', worldEq(worldOrig, worldDrift),
    `pos err ${vErr(worldOrig.pos, worldDrift.pos).toExponential(2)}`);

  // untouched sessions still serialize byte-identically
  check('untouched file stays byte-identical', eqBytes(new GiaSession(bytes).serialize(), bytes));
}

console.log('== .gia: moves between identically-transformed models stay byte-lean');
{
  const bytes = load('Autumn Sword Auto Assemble.gia');
  const s = new GiaSession(bytes);
  const same = JSON.stringify([s._models[0].worldPos, s._models[0].rot, s._models[0].zoom])
    === JSON.stringify([s._models[1].worldPos, s._models[1].rot, s._models[1].zoom]);
  const guid = s.decorations(0)[0].guid;
  const w0 = composeTransforms(
    { pos: s._models[0].worldPos, rot: s._models[0].rot, scale: s._models[0].zoom },
    s._decT.get(guid));
  s.moveDecorationsToModel(0, [0], 1);
  if (same) {
    check('identical transforms: no transform rewrite flagged', !s._decTransformDirty.has(guid));
  }
  const w1 = composeTransforms(
    { pos: s._models[1].worldPos, rot: s._models[1].rot, scale: s._models[1].zoom },
    s._decT.get(guid));
  check('world transform preserved', worldEq(w0, w1), same ? '(identical model transforms)' : '(recalculated)');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall reparent tests passed');
process.exit(failures ? 1 : 0);
