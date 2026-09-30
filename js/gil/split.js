/**
 * split.js: the decoration-extraction operation.
 *
 * Converts decorations (level field 27 entries) owned by selected parent
 * objects into standalone world objects (level field 5 entries), composing the
 * parent transform with each decoration's local transform, registering the new
 * objects in the world-object registry (level field 6), and clearing the
 * parents' decoration-id lists. Everything else is preserved byte-for-byte.
 *
 * Transform model (verified against the reference files):
 *   worldPos   = parentPos + parentRot * (parentScale ⊙ localPos)
 *   worldRot   = parentRot ∘ localRot
 *   worldScale = parentScale ⊙ localScale
 * Rotations are Euler angles in degrees applied in Unity order (Z, then X,
 * then Y). All reference parents have identity rotation and unit scale, where
 * this reduces to worldPos = parentPos + localPos, which matches the samples
 * exactly. The general composition follows the engine convention (Unity).
 * Component-wise scale composition is exact unless a parent combines
 * non-uniform scale with rotated children (which introduces shear no single
 * transform can represent); the flattened transform is the engine-standard
 * approximation and such tiny differences are not surfaced as warnings. The
 * only transform-related warning is the game's zoom limit (MAX_SCALE).
 */
'use strict';

import {
  parseMessage,
  encodeMessage,
  getField,
  getFields,
  varintField,
  msgField,
  bytesField,
  f32Field,
  fieldVarint,
  decodePackedVarints,
  encodePackedVarints,
} from './gil.js';
import {
  COMP_A_PAYLOAD,
  COMP_B_PAYLOAD,
  readComponent,
  REGISTRY_KIND_WORLD_OBJECT,
} from './model.js';

export const MAX_SCALE = 50;

// ------------------------------------------------------------------ math

const DEG = Math.PI / 180;

/** Quaternion from Euler degrees, Unity order (extrinsic Z-X-Y): q = qy*qx*qz */
export function quatFromEuler(e) {
  const hx = (e.x * DEG) / 2;
  const hy = (e.y * DEG) / 2;
  const hz = (e.z * DEG) / 2;
  const cx = Math.cos(hx), sx = Math.sin(hx);
  const cy = Math.cos(hy), sy = Math.sin(hy);
  const cz = Math.cos(hz), sz = Math.sin(hz);
  // qy * qx * qz
  return {
    x: cy * sx * cz + sy * cx * sz,
    y: sy * cx * cz - cy * sx * sz,
    z: cy * cx * sz - sy * sx * cz,
    w: cy * cx * cz + sy * sx * sz,
  };
}

export function quatMul(a, b) {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

export function quatRotate(q, v) {
  // v' = q v q^-1
  const { x, y, z, w } = q;
  const ux = 2 * (y * v.z - z * v.y);
  const uy = 2 * (z * v.x - x * v.z);
  const uz = 2 * (x * v.y - y * v.x);
  return {
    x: v.x + w * ux + (y * uz - z * uy),
    y: v.y + w * uy + (z * ux - x * uz),
    z: v.z + w * uz + (x * uy - y * ux),
  };
}

/** Euler degrees (Unity Z-X-Y convention) from quaternion. */
export function eulerFromQuat(q) {
  // Unity: x = asin(-m12), y = atan2(m02, m22), z = atan2(m10, m11)
  const { x, y, z, w } = q;
  const m10 = 2 * (x * y + w * z);
  const m11 = 1 - 2 * (x * x + z * z);
  const m12 = 2 * (y * z - w * x);
  const m02 = 2 * (x * z + w * y);
  const m22 = 1 - 2 * (x * x + y * y);
  let ex, ey, ez;
  const s = Math.max(-1, Math.min(1, -m12));
  ex = Math.asin(s);
  if (Math.abs(s) > 0.9999999) {
    // gimbal lock: fold z into y
    const m01 = 2 * (x * y - w * z);
    const m00 = 1 - 2 * (y * y + z * z);
    ey = Math.atan2(-m01, m00);
    ez = 0;
  } else {
    ey = Math.atan2(m02, m22);
    ez = Math.atan2(m10, m11);
  }
  const norm = (a) => {
    let d = a / DEG;
    if (Math.abs(d) < 1e-7) d = 0;
    if (d < 0) d += 360;
    if (d >= 360) d -= 360;
    return d;
  };
  return { x: norm(ex), y: norm(ey), z: norm(ez) };
}

const isIdentityRot = (e) =>
  (e.x % 360 === 0) && (e.y % 360 === 0) && (e.z % 360 === 0);

/**
 * Build a composer for one parent transform. Precomputes the parent's
 * quaternion and flags once so composing hundreds of decorations under the
 * same parent does no repeated trigonometry.
 */
export function makeParentComposer(parent) {
  const ps = parent.scale;
  const pp = parent.pos;
  const rotIdentity = isIdentityRot(parent.rot);
  const pq = rotIdentity ? null : quatFromEuler(parent.rot);
  const nonUniform = Math.abs(ps.x - ps.y) > 1e-6 || Math.abs(ps.y - ps.z) > 1e-6;
  return (local) => {
    const ls = local.scale;
    const scaled = { x: ps.x * local.pos.x, y: ps.y * local.pos.y, z: ps.z * local.pos.z };
    let rotated = scaled;
    let rot = local.rot;
    if (pq) {
      rotated = quatRotate(pq, scaled);
      rot = eulerFromQuat(quatMul(pq, quatFromEuler(local.rot)));
    }
    return {
      pos: { x: pp.x + rotated.x, y: pp.y + rotated.y, z: pp.z + rotated.z },
      rot,
      scale: { x: ps.x * ls.x, y: ps.y * ls.y, z: ps.z * ls.z },
      shearRisk: nonUniform && !isIdentityRot(local.rot),
    };
  };
}

/**
 * Compose parent and local {pos, rot, scale}.
 * Returns {pos, rot, scale, shearRisk}. (shearRisk is informational; tiny
 * flattening differences are expected and not surfaced as warnings.)
 */
export function composeTransforms(parent, local) {
  return makeParentComposer(parent)(local);
}

// --------------------------------------------------------- field builders

/** Encode a vec3 as {1:x,2:y,3:z}, omitting zero components (as the game does). */
function encodeVec3(v) {
  const fields = [];
  if (v.x !== 0) fields.push(f32Field(1, v.x));
  if (v.y !== 0) fields.push(f32Field(2, v.y));
  if (v.z !== 0) fields.push(f32Field(3, v.z));
  return encodeMessage(fields);
}

function compA(type, payloadRaw) {
  const pf = COMP_A_PAYLOAD[type];
  return msgField(5, [varintField(1, type), bytesField(pf, payloadRaw)]);
}
function compB(type, payloadRaw) {
  const pf = COMP_B_PAYLOAD[type];
  return msgField(6, [varintField(1, type), bytesField(pf, payloadRaw)]);
}
const EMPTY = new Uint8Array(0);
const TEXT = new TextEncoder();

// Constant component fields shared by every built world object, encoded once
// at module load instead of per decoration (encodeMessage copies bytes, so
// sharing the field objects is safe).
const C_A13 = compA(13, encodeMessage([varintField(4, 0xffffffff)]));
const C_A14 = compA(14, encodeMessage([msgField(1, [{ num: 3, wire: 2, raw: TEXT.encode('MPActionGroup') }])]));
const C_A38 = compA(38, EMPTY);
const C_A111 = compA(111, EMPTY);
const C_A61 = compA(61, EMPTY);
const C_A62 = compA(62, EMPTY);
const C_A19 = compA(19, EMPTY);
const C_A52 = compA(52, EMPTY);
const C_A40_EMPTY = compA(40, EMPTY);
const C_B2 = compB(2, EMPTY);
const C_B3 = compB(3, EMPTY);
const C_B4 = compB(4, encodeMessage([varintField(1, 1)]));
const C_B5_DEFAULT_FIELDS = [varintField(1, 1), varintField(2, 1)];
const C_B6 = compB(6, EMPTY);
const C_B7 = compB(
  7,
  encodeMessage([
    f32Field(1, 10),
    f32Field(2, 1),
    f32Field(3, 500),
    varintField(5, 1),
    msgField(6, [varintField(2, 10200002)]),
    f32Field(8, 0.1),
    f32Field(9, 0.1),
    f32Field(10, 0.1),
    f32Field(11, 0.1),
    f32Field(12, 0.1),
    f32Field(13, 0.1),
    f32Field(14, 0.1),
    f32Field(15, 0.1),
  ])
);
const C_B8 = compB(8, encodeMessage([varintField(1, 1), varintField(501, 1)]));
const C_B11 = compB(
  11,
  encodeMessage([
    msgField(1, [
      { num: 1, wire: 2, raw: TEXT.encode('GI_RootNode') },
      bytesField(2, EMPTY),
      bytesField(3, EMPTY),
      { num: 502, wire: 2, raw: TEXT.encode('Center Origin') },
      varintField(504, 1),
      { num: 505, wire: 2, raw: TEXT.encode('RootNode') },
    ]),
  ])
);
const C_B12 = compB(12, encodeMessage([varintField(501, 1)]));
const C_B16 = compB(16, EMPTY);
const C_B17 = compB(17, EMPTY);
const C_B19 = compB(19, encodeMessage([varintField(1, 1)]));
const C_B20 = compB(20, EMPTY);
const C_B22_DEFAULT = compB(
  22,
  encodeMessage([
    varintField(3, 0xffffffff),
    f32Field(4, 100),
    varintField(5, 16777215),
    varintField(6, 6700),
  ])
);
const T501 = varintField(501, 0xffffffff);
const PREFAB_ONE = varintField(2, 1);

// -------------------------------------------------------------- planning

/**
 * Compute what a split of `parentIds` would do, without modifying anything.
 * Returns {entries, warnings, errors}.
 * entries: [{parent, deco, world: {pos, rot, scale}}]
 * warnings/errors: structured {code, params} objects so the UI can localize
 * them (codes: objectNotFound, noDecorations, parentNoTransform,
 * decoMissing, decoOtherParent, decoNoTransform, scaleExceeds,
 * parentRefsDecos).
 * opts.onlyDecoIds: Set. When given, only these decorations are extracted;
 * the rest stay attached to their parents.
 */
export function planSplit(level, parentIds, opts = {}) {
  const onlyDecoIds = opts.onlyDecoIds || null;
  const entries = [];
  const warnings = [];
  const errors = [];
  const decoById = new Map(level.decorations.map((d) => [d.id, d]));

  for (const pid of parentIds) {
    const parent = level.objectById(pid);
    if (!parent) {
      errors.push({ code: 'objectNotFound', params: { id: pid } });
      continue;
    }
    const pname = parent.name ?? '';
    if (!parent.decorationIds.length) {
      warnings.push({ code: 'noDecorations', params: { name: pname, id: pid } });
      continue;
    }
    if (!parent.transform) {
      errors.push({ code: 'parentNoTransform', params: { name: pname, id: pid } });
      continue;
    }
    // One composer per parent: the parent's rotation/scale math is computed
    // once, not per decoration.
    const compose = makeParentComposer(parent.transform);
    const extractedHere = new Set();
    for (const did of parent.decorationIds) {
      if (onlyDecoIds && !onlyDecoIds.has(did)) continue;
      const deco = decoById.get(did);
      if (!deco) {
        errors.push({ code: 'decoMissing', params: { decoId: did, name: pname, id: pid } });
        continue;
      }
      if (deco.parentId !== null && deco.parentId !== pid) {
        warnings.push({
          code: 'decoOtherParent',
          params: { decoId: did, otherId: deco.parentId, id: pid },
        });
      }
      if (!deco.transform) {
        errors.push({ code: 'decoNoTransform', params: { decoId: did } });
        continue;
      }
      const world = compose(deco.transform);
      // The only transform-related warning: the game's zoom limit. Tiny
      // position/rotation flattening differences are expected and NOT warned.
      // One warning per object, listing every axis over the limit.
      const over = [];
      for (const axis of ['x', 'y', 'z']) {
        if (Math.abs(world.scale[axis]) > MAX_SCALE) {
          over.push(axis.toUpperCase() + ': ' + (Math.round(world.scale[axis] * 10) / 10));
        }
      }
      if (over.length) {
        warnings.push({
          code: 'scaleExceeds',
          params: {
            name: deco.name || String(did),
            decoId: did,
            parentName: pname || String(pid),
            axes: over.join(' · '),
            max: MAX_SCALE,
          },
        });
      }
      entries.push({ parent, deco, world });
      extractedHere.add(did);
    }
    // Cross-reference check: other components of the parent referencing the
    // decoration ids being extracted (seen with e.g. water bodies).
    if (extractedHere.size && parentReferencesDecoIds(parent, extractedHere)) {
      warnings.push({ code: 'parentRefsDecos', params: { name: pname, id: pid } });
    }
  }
  return { entries, warnings, errors };
}

/** Scan parent component payloads (other than the deco-id list) for varints equal to extracted ids. */
function parentReferencesDecoIds(parent, idSet) {
  const scan = (raw, depth, insideC40) => {
    if (depth > 6 || !raw.length) return false;
    let fields;
    try {
      fields = parseMessage(raw);
    } catch {
      return false;
    }
    for (const f of fields) {
      if (f.wire === 0) {
        if (f.num !== 1 && idSet.has(fieldVarint(f)) && !insideC40) return true;
      } else if (f.wire === 2) {
        if (scan(f.raw, depth + 1, insideC40)) return true;
      }
    }
    return false;
  };
  for (const list of [parent.compA, parent.compB]) {
    for (const cf of list) {
      let c;
      try {
        c = readComponent(cf, list === parent.compA ? COMP_A_PAYLOAD : COMP_B_PAYLOAD);
      } catch {
        continue;
      }
      const insideC40 = list === parent.compA && c.type === 40;
      if (c.payload && scan(c.payload.raw, 0, insideC40)) return true;
    }
  }
  return false;
}

// ------------------------------------------------- parent-removal safety

/**
 * Allocation-free scan of a wire-format region [start, end) of `buf`.
 * Validates the region as a message first (no captures), then walks it,
 * counting varint values present in `idSet` into `hits`, ignoring
 * `selfId` (a candidate's matches inside its own entry). Nested
 * length-delimited fields are recursed into when they parse as messages.
 * Returns true when the region was a valid message.
 */
function scanRegion(buf, start, end, depth, idSet, hits, selfId) {
  if (depth > 8) return false;
  // validation pass: structure only
  let pos = start;
  while (pos < end) {
    let key = 0;
    let shift = 0;
    let b;
    do {
      if (pos >= end || shift > 35) return false;
      b = buf[pos++];
      key |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    const wire = key & 7;
    if (key >>> 3 === 0) return false;
    if (wire === 0) {
      let n = 0;
      do {
        if (pos >= end || n > 9) return false;
        b = buf[pos++];
        n++;
      } while (b & 0x80);
    } else if (wire === 1) {
      pos += 8;
      if (pos > end) return false;
    } else if (wire === 5) {
      pos += 4;
      if (pos > end) return false;
    } else if (wire === 2) {
      let len = 0;
      shift = 0;
      do {
        if (pos >= end || shift > 35) return false;
        b = buf[pos++];
        len += (b & 0x7f) * 2 ** shift;
        shift += 7;
      } while (b & 0x80);
      pos += len;
      if (pos > end) return false;
    } else {
      return false;
    }
  }
  // walk pass: count matches, recurse into nested messages
  pos = start;
  while (pos < end) {
    let key = 0;
    let shift = 0;
    let b;
    do {
      b = buf[pos++];
      key |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    const wire = key & 7;
    if (wire === 0) {
      let v = 0;
      let mul = 1;
      do {
        b = buf[pos++];
        v += (b & 0x7f) * mul;
        mul *= 128;
      } while (b & 0x80);
      if (v !== selfId && idSet.has(v)) hits.set(v, (hits.get(v) || 0) + 1);
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else {
      let len = 0;
      shift = 0;
      do {
        b = buf[pos++];
        len += (b & 0x7f) * 2 ** shift;
        shift += 7;
      } while (b & 0x80);
      if (len > 0) scanRegion(buf, pos, pos + len, depth + 1, idSet, hits, selfId);
      pos += len;
    }
  }
  return true;
}

/** Read the id (field 1 varint) of an object/decoration entry without a full
 * parse. Returns null when the entry does not start with field 1. */
function peekEntryId(raw) {
  if (!raw.length || raw[0] !== 0x08) return null; // key: field 1, wire 0
  let v = 0;
  let mul = 1;
  let pos = 1;
  for (;;) {
    if (pos >= raw.length) return null;
    const b = raw[pos++];
    v += (b & 0x7f) * mul;
    if (!(b & 0x80)) return v;
    mul *= 128;
  }
}

/**
 * Scan the level once for references to any of the candidate ids, outside
 * the places extraction already handles: each candidate's own object entry,
 * its registry kind-200 item, and the decorations being extracted with it.
 * Returns Map<id, count>. Conservative: unknown sections are walked as
 * nested messages and any varint equal to a candidate id counts.
 */
export function collectExternalIdReferences(level, idSet, extractedDecoIds = new Set()) {
  const hits = new Map();
  for (const top of level.root) {
    if (top.wire !== 2) continue;
    const raw = top.raw;
    if (top === level.objectContainerField || top === level.decoContainerField) {
      // Walk entries individually: candidate entries ignore self-matches;
      // decorations being extracted are removed anyway and are skipped.
      let fields;
      try {
        fields = parseMessage(raw);
      } catch {
        continue;
      }
      const isDecoContainer = top === level.decoContainerField;
      for (const f of fields) {
        if (f.wire !== 2) continue;
        const entryId = peekEntryId(f.raw);
        if (isDecoContainer && entryId !== null && extractedDecoIds.has(entryId)) continue;
        const selfId = !isDecoContainer && entryId !== null && idSet.has(entryId) ? entryId : -1;
        scanRegion(f.raw, 0, f.raw.length, 1, idSet, hits, selfId);
      }
    } else if (top === level.registryContainerField) {
      // Registry: candidates' own kind-200 items are deleted with them.
      let groups;
      try {
        groups = parseMessage(raw);
      } catch {
        continue;
      }
      for (const g of groups) {
        if (g.wire !== 2) continue;
        let gf;
        try {
          gf = parseMessage(g.raw);
        } catch {
          continue;
        }
        for (const f of gf) {
          if (f.num === 3 && f.wire === 2 && f.raw.length) {
            let tf;
            try {
              tf = parseMessage(f.raw);
            } catch {
              continue;
            }
            for (const item of tf) {
              if (item.wire !== 2) {
                if (item.wire === 0) {
                  const v = fieldVarint(item);
                  if (idSet.has(v)) hits.set(v, (hits.get(v) || 0) + 1);
                }
                continue;
              }
              if (item.num === 5) {
                try {
                  const itf = parseMessage(item.raw);
                  const kindF = getField(itf, 1);
                  const idF = getField(itf, 2);
                  if (
                    kindF && idF &&
                    fieldVarint(kindF) === REGISTRY_KIND_WORLD_OBJECT &&
                    idSet.has(fieldVarint(idF))
                  ) {
                    continue; // the item we would delete
                  }
                } catch {
                  /* fall through to scan */
                }
              }
              scanRegion(item.raw, 0, item.raw.length, 2, idSet, hits, -1);
            }
          } else if (f.wire === 2) {
            scanRegion(f.raw, 0, f.raw.length, 2, idSet, hits, -1);
          } else if (f.wire === 0) {
            const v = fieldVarint(f);
            if (idSet.has(v)) hits.set(v, (hits.get(v) || 0) + 1);
          }
        }
      }
    } else {
      scanRegion(raw, 0, raw.length, 0, idSet, hits, -1);
    }
  }
  return hits;
}

/** Number of external references to a single id (compatibility wrapper). */
export function countExternalIdReferences(level, id) {
  return collectExternalIdReferences(level, new Set([id])).get(id) || 0;
}

/**
 * Decide which of the given parents can safely be deleted after extraction.
 * One pass over the level regardless of how many parents are checked.
 * Returns {removable: Set<id>, warnings: [{code:'parentKeptReferenced', params}]}.
 */
export function checkParentRemoval(level, parentIds) {
  const removable = new Set();
  const warnings = [];
  const candidates = [];
  const idSet = new Set();
  const extractedDecoIds = new Set();
  for (const pid of parentIds) {
    const parent = level.objectById(pid);
    if (!parent) continue;
    candidates.push(parent);
    idSet.add(pid);
    for (const did of parent.decorationIds) extractedDecoIds.add(did);
  }
  if (!candidates.length) return { removable, warnings };
  const hits = collectExternalIdReferences(level, idSet, extractedDecoIds);
  for (const parent of candidates) {
    const refs = hits.get(parent.id) || 0;
    if (refs > 0) {
      warnings.push({
        code: 'parentKeptReferenced',
        params: { name: parent.name ?? '', id: parent.id, count: refs },
      });
    } else {
      removable.add(parent.id);
    }
  }
  return { removable, warnings };
}

// -------------------------------------------------------------- execution

/** Collision state of a freshly built world-object field (B/5 flag 1). */
function readBuiltCollision(objField) {
  for (const f of parseMessage(objField.raw)) {
    if (f.num !== 6 || f.wire !== 2) continue;
    try {
      const cf = parseMessage(f.raw);
      const typeF = getField(cf, 1);
      if (!typeF || typeF.wire !== 0 || fieldVarint(typeF) !== 5) continue;
      const pf = getField(cf, 15);
      if (!pf || !pf.raw.length) return false;
      const f1 = getField(parseMessage(pf.raw), 1);
      return !!(f1 && f1.wire === 0 && fieldVarint(f1) !== 0);
    } catch {
      /* keep scanning */
    }
  }
  return false;
}

/**
 * Build the serialized world-object field for an extracted decoration.
 * Mirrors the component layout of world objects in the reference files while
 * carrying over every field of the decoration itself.
 *
 * opts.collision: true → force collision enabled on the new object,
 * false → force disabled, undefined/null → preserve the decoration's state.
 * Unknown subfields of the collision component survive in every mode; only
 * the two known flag fields (1, 2) are set or cleared.
 */
export function buildWorldObject(deco, world, newId, opts = {}) {
  const consumedA = new Set();
  const consumedB = new Set();
  const decoA = new Map(); // type -> component
  const decoB = new Map();
  const unknownA = [];
  const unknownB = [];
  for (const cf of deco.compA) {
    try {
      const c = readComponent(cf, COMP_A_PAYLOAD);
      if (c.type !== null && !decoA.has(c.type)) decoA.set(c.type, c);
      else unknownA.push(cf);
    } catch {
      unknownA.push(cf);
    }
  }
  for (const cf of deco.compB) {
    try {
      const c = readComponent(cf, COMP_B_PAYLOAD);
      if (c.type !== null && !decoB.has(c.type)) decoB.set(c.type, c);
      else unknownB.push(cf);
    } catch {
      unknownB.push(cf);
    }
  }

  const fields = [];
  fields.push(varintField(1, newId));
  fields.push(msgField(2, [varintField(1, deco.prefabId), PREFAB_ONE]));

  // ---- component list A (field 5), template order from reference files.
  const takeA = (type) => {
    const c = decoA.get(type);
    if (c) consumedA.add(type);
    return c;
  };
  const nameComp = takeA(1);
  fields.push(compA(1, nameComp && nameComp.payload ? nameComp.payload.raw : EMPTY));
  fields.push(C_A13);
  fields.push(C_A14);
  fields.push(C_A38);
  // Type 40 on a world object: keep any decoration fields except the parent
  // link (502) and child list (501).
  const c40 = takeA(40);
  let c40Raw = EMPTY;
  if (c40 && c40.payload && c40.payload.raw.length) {
    try {
      const kept = parseMessage(c40.payload.raw).filter((f) => f.num !== 501 && f.num !== 502);
      c40Raw = encodeMessage(kept);
    } catch {
      c40Raw = EMPTY;
    }
  }
  fields.push(c40Raw.length ? compA(40, c40Raw) : C_A40_EMPTY);
  const c111 = takeA(111);
  fields.push(c111 && c111.payload && c111.payload.raw.length ? compA(111, c111.payload.raw) : C_A111);
  fields.push(C_A61);
  fields.push(C_A62);
  fields.push(C_A19);
  fields.push(C_A52);
  // Decoration components of types not in the template are carried over as-is.
  for (const [type, c] of decoA) {
    if (!consumedA.has(type)) fields.push(msgField(5, c.fields));
  }
  for (const cf of unknownA) fields.push({ num: 5, wire: 2, raw: cf.raw });

  // ---- component list B (field 6).
  const takeB = (type) => {
    const c = decoB.get(type);
    if (c) consumedB.add(type);
    return c;
  };
  // Transform: start from the decoration's own transform fields (preserving
  // unknown subfields), replace pos/rot/scale, ensure the 501 marker.
  const tComp = takeB(1);
  let tFields = [];
  if (tComp && tComp.payload && tComp.payload.raw.length) {
    try {
      tFields = parseMessage(tComp.payload.raw);
    } catch {
      tFields = [];
    }
  }
  const newT = [];
  let saw501 = false;
  const posRaw = encodeVec3(world.pos);
  const rotRaw = encodeVec3(world.rot);
  const scaleRaw = encodeVec3(world.scale);
  let saw1 = false, saw2 = false, saw3 = false;
  for (const f of tFields) {
    if (f.num === 1 && f.wire === 2) { newT.push(bytesField(1, posRaw)); saw1 = true; }
    else if (f.num === 2 && f.wire === 2) { newT.push(bytesField(2, rotRaw)); saw2 = true; }
    else if (f.num === 3 && f.wire === 2) { newT.push(bytesField(3, scaleRaw)); saw3 = true; }
    else {
      if (f.num === 501) saw501 = true;
      newT.push(f);
    }
  }
  if (!saw1) newT.splice(0, 0, bytesField(1, posRaw));
  if (!saw2) newT.splice(1, 0, bytesField(2, rotRaw));
  if (!saw3) newT.splice(2, 0, bytesField(3, scaleRaw));
  if (!saw501) newT.push(T501);
  fields.push(compB(1, encodeMessage(newT)));

  const c2 = takeB(2);
  fields.push(c2 && c2.payload && c2.payload.raw.length ? compB(2, c2.payload.raw) : C_B2);
  fields.push(C_B3);
  fields.push(C_B4);
  // Type 5 = static collision ("PropertyStaticCollider"): {1:1,2:1} enabled,
  // empty disabled. Optionally overridden; unknown subfields are kept.
  const c5 = takeB(5);
  let c5Fields = [];
  if (c5 && c5.payload && c5.payload.raw.length) {
    try {
      c5Fields = parseMessage(c5.payload.raw);
    } catch {
      c5Fields = [];
    }
  } else if (!c5 && opts.collision == null) {
    // Component absent on the decoration: emit the observed world-object
    // default (enabled), as before.
    c5Fields = C_B5_DEFAULT_FIELDS;
  }
  if (opts.collision === true || opts.collision === false) {
    const rest = c5Fields.filter((f) => f.num !== 1 && f.num !== 2);
    c5Fields = opts.collision ? [...C_B5_DEFAULT_FIELDS, ...rest] : rest;
  }
  fields.push(compB(5, encodeMessage(c5Fields)));
  fields.push(C_B6);
  // Type 7 (interaction/range block): constant across reference world objects.
  fields.push(C_B7);
  fields.push(C_B8);
  fields.push(C_B11);
  fields.push(C_B12);
  fields.push(C_B16);
  fields.push(C_B17);
  fields.push(C_B19);
  fields.push(C_B20);
  const c22 = takeB(22);
  fields.push(c22 && c22.payload && c22.payload.raw.length ? compB(22, c22.payload.raw) : C_B22_DEFAULT);
  for (const [type, c] of decoB) {
    if (!consumedB.has(type)) fields.push(msgField(6, c.fields));
  }
  for (const cf of unknownB) fields.push({ num: 6, wire: 2, raw: cf.raw });

  fields.push(varintField(8, deco.prefabId));

  // Any decoration top-level fields we did not map (unknown/future data) are
  // carried over verbatim, except the known structural ones.
  for (const f of deco.fields) {
    if (f.num === 1 || f.num === 2 || f.num === 4 || f.num === 5) continue;
    if (f.num === 12 && f.raw.length === 0) continue; // observed-empty marker on decorations only
    fields.push(f);
  }

  return msgField(1, fields);
}

/**
 * Apply a split. Mutates level.root (containers 5, 6, 27) and returns a
 * summary {created:[{id, name, prefabId}], removedDecorations, parents,
 * removedParents}.
 * Call planSplit first; this assumes entries are valid.
 * opts.collision: see buildWorldObject.
 * opts.removeParent: delete parents after extraction, but only those ids in
 * opts.removableParents (from checkParentRemoval); others keep their entry
 * (minus the decoration list) so no references dangle.
 * opts.onProgress(done, total): called periodically during the build phase.
 * The function is async and yields to the UI thread between batches so large
 * operations (thousands of decorations) do not freeze the page; the level is
 * only mutated at the end, after everything has been built.
 */
const yieldToUI = () => new Promise((r) => setTimeout(r, 0));

export async function applySplit(level, plan, opts = {}) {
  const { entries } = plan;
  if (!entries.length) return { created: [], removedDecorations: 0, parents: 0, removedParents: 0 };
  const onProgress = opts.onProgress || null;

  // ---- allocate ids
  // World objects live in the 0x4040xxxx id space; the registry can also list
  // special kind-200 entries from other spaces (e.g. 0x4140xxxx), which must
  // not influence allocation. Matches the game: next id = highest existing
  // object id in the space + 1, skipping anything referenced anywhere.
  const used = level.allWorldObjectIds();
  const SPACE_BASE = 0x40400000;
  const SPACE_END = 0x40500000;
  let nextId = SPACE_BASE + 1;
  for (const o of level.objects) {
    if (o.id !== null && o.id > nextId - 1 && o.id >= SPACE_BASE && o.id < SPACE_END) nextId = o.id + 1;
  }
  const alloc = () => {
    while (used.has(nextId)) nextId++;
    const id = nextId++;
    used.add(id);
    return id;
  };

  // ---- build new world objects (batched; yields keep the UI responsive)
  const newObjects = [];
  const removedDecoIds = new Set();
  let lastYield = Date.now();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const id = alloc();
    newObjects.push({ field: buildWorldObject(e.deco, e.world, id, opts), id, deco: e.deco });
    removedDecoIds.add(e.deco.id);
    if ((i & 63) === 63 && Date.now() - lastYield > 24) {
      if (onProgress) onProgress(i + 1, entries.length);
      await yieldToUI();
      lastYield = Date.now();
    }
  }
  if (onProgress) onProgress(entries.length, entries.length);

  // Safety net: when a collision override is requested, verify every new
  // object actually carries the requested state before anything is mutated.
  if (opts.collision === true || opts.collision === false) {
    for (const o of newObjects) {
      const state = readBuiltCollision(o.field);
      if (state !== opts.collision) {
        throw new Error(`Internal error: object ${o.id} collision state mismatch`);
      }
    }
  }

  // ---- container 5: append new objects after the last existing object entry
  const objCont = level.objectContainerField;
  const objFields = objCont.raw.length ? parseMessage(objCont.raw) : [];
  let lastObj = -1;
  for (let i = 0; i < objFields.length; i++) if (objFields[i].num === 1) lastObj = i;
  objFields.splice(lastObj + 1, 0, ...newObjects.map((o) => o.field));

  // ---- parent handling: rewrite each parent's decoration-id list (501) to
  // keep decorations that were not extracted; parents left empty may then be
  // deleted when removal is requested and safe.
  const parentIds = new Set(entries.map((e) => e.parent.id));
  // Fast id lookup for entries: peek the leading field-1 varint instead of a
  // full parse (objects always serialize their id first); fall back to a
  // parse only when the peek fails.
  const entryId = (f) => {
    const peeked = peekEntryId(f.raw);
    if (peeked !== null) return peeked;
    try {
      const idF = getField(parseMessage(f.raw), 1);
      return idF && idF.wire === 0 ? fieldVarint(idF) : null;
    } catch {
      return null;
    }
  };
  const emptiedParents = new Set();
  for (let i = 0; i < objFields.length; i++) {
    const f = objFields[i];
    if (f.num !== 1 || f.wire !== 2) continue;
    const oid = entryId(f);
    if (!parentIds.has(oid)) continue;
    let of;
    try {
      of = parseMessage(f.raw);
    } catch {
      continue;
    }
    let changed = false;
    let remaining = 0;
    for (let j = 0; j < of.length; j++) {
      const cf = of[j];
      if (cf.num !== 5 || cf.wire !== 2) continue;
      let c;
      try {
        c = readComponent(cf, COMP_A_PAYLOAD);
      } catch {
        continue;
      }
      if (c.type !== 40 || !c.payload || !c.payload.raw.length) continue;
      const kept = [];
      for (const pf of parseMessage(c.payload.raw)) {
        if (pf.num === 501 && pf.wire === 2) {
          const still = decodePackedVarints(pf.raw).filter((id) => !removedDecoIds.has(id));
          remaining += still.length;
          if (still.length) kept.push(bytesField(501, encodePackedVarints(still)));
        } else {
          kept.push(pf);
        }
      }
      const newComp = c.fields.map((x) =>
        x === c.payload ? bytesField(c.payloadFieldNum, encodeMessage(kept)) : x
      );
      of[j] = msgField(5, newComp);
      changed = true;
    }
    if (changed) objFields[i] = msgField(1, of);
    if (remaining === 0) emptiedParents.add(oid);
  }
  // ---- deletion: only requested, reference-safe parents that ended up with
  // no decorations left inside.
  const toRemove = new Set();
  if (opts.removeParent) {
    const removable = opts.removableParents ?? new Set(parentIds);
    for (const pid of parentIds) {
      if (removable.has(pid) && emptiedParents.has(pid)) toRemove.add(pid);
    }
  }
  if (toRemove.size) {
    const filtered = objFields.filter(
      (f) => !(f.num === 1 && f.wire === 2 && toRemove.has(entryId(f)))
    );
    objFields.length = 0;
    objFields.push(...filtered);
  }
  objCont.raw = encodeMessage(objFields);

  // ---- container 27: drop extracted decoration entries
  const decoCont = level.decoContainerField;
  if (decoCont && decoCont.raw.length) {
    const df = parseMessage(decoCont.raw);
    const kept = df.filter((f) => {
      if (f.num !== 2 || f.wire !== 2) return true;
      const peeked = peekEntryId(f.raw);
      if (peeked !== null) return !removedDecoIds.has(peeked);
      try {
        const idF = getField(parseMessage(f.raw), 1);
        return !(idF && idF.wire === 0 && removedDecoIds.has(fieldVarint(idF)));
      } catch {
        return true;
      }
    });
    decoCont.raw = kept.length ? encodeMessage(kept) : new Uint8Array(0);
  }

  // ---- container 6: drop removed parents' registry items, then register
  // the new ids in the world-object registry group
  const regCont = level.registryContainerField;
  if (regCont && regCont.raw.length && toRemove.size) {
    const regFields = parseMessage(regCont.raw);
    let changed = false;
    for (let i = 0; i < regFields.length; i++) {
      const g = regFields[i];
      if (g.num !== 1 || g.wire !== 2) continue;
      let gf;
      try {
        gf = parseMessage(g.raw);
      } catch {
        continue;
      }
      let groupChanged = false;
      for (let j = 0; j < gf.length; j++) {
        const tab = gf[j];
        if (tab.num !== 3 || tab.wire !== 2 || !tab.raw.length) continue;
        let tf;
        try {
          tf = parseMessage(tab.raw);
        } catch {
          continue;
        }
        const kept = tf.filter((item) => {
          if (item.num !== 5 || item.wire !== 2) return true;
          try {
            const itf = parseMessage(item.raw);
            const kindF = getField(itf, 1);
            const idF = getField(itf, 2);
            return !(
              kindF && idF &&
              fieldVarint(kindF) === REGISTRY_KIND_WORLD_OBJECT &&
              toRemove.has(fieldVarint(idF))
            );
          } catch {
            return true;
          }
        });
        if (kept.length !== tf.length) {
          gf[j] = msgField(3, kept);
          groupChanged = true;
        }
      }
      if (groupChanged) {
        regFields[i] = msgField(1, gf);
        changed = true;
      }
    }
    if (changed) regCont.raw = encodeMessage(regFields);
  }
  if (regCont && regCont.raw.length) {
    const regFields = parseMessage(regCont.raw);
    // Candidate groups: registry entries whose tab holds kind-200 items.
    // Prefer the group already containing a parent's id; else the first.
    let bestIdx = -1;
    let bestHasParent = false;
    const parsedGroups = new Map(); // idx -> {gf, ti, tf}
    for (let i = 0; i < regFields.length; i++) {
      const g = regFields[i];
      if (g.num !== 1 || g.wire !== 2) continue;
      let gf;
      try {
        gf = parseMessage(g.raw);
      } catch {
        continue;
      }
      const ti = gf.findIndex((f) => f.num === 3 && f.wire === 2 && f.raw.length);
      if (ti === -1) continue;
      let tf;
      try {
        tf = parseMessage(gf[ti].raw);
      } catch {
        continue;
      }
      let hasWorldItems = false;
      let hasParent = false;
      for (const item of tf) {
        if (item.num !== 5 || item.wire !== 2) continue;
        try {
          const itf = parseMessage(item.raw);
          const kindF = getField(itf, 1);
          const idF = getField(itf, 2);
          if (kindF && idF && fieldVarint(kindF) === REGISTRY_KIND_WORLD_OBJECT) {
            hasWorldItems = true;
            if (parentIds.has(fieldVarint(idF))) hasParent = true;
          }
        } catch {
          /* ignore */
        }
      }
      if (hasWorldItems) {
        parsedGroups.set(i, { gf, ti, tf });
        if (hasParent && !bestHasParent) {
          bestIdx = i;
          bestHasParent = true;
        } else if (bestIdx === -1) {
          bestIdx = i;
        }
      }
    }
    if (bestIdx !== -1) {
      const { gf, ti, tf } = parsedGroups.get(bestIdx);
      let lastItem = -1;
      for (let i = 0; i < tf.length; i++) if (tf[i].num === 5) lastItem = i;
      const newItems = newObjects.map((o) =>
        msgField(5, [varintField(1, REGISTRY_KIND_WORLD_OBJECT), varintField(2, o.id)])
      );
      tf.splice(lastItem + 1, 0, ...newItems);
      gf[ti] = msgField(3, tf);
      regFields[bestIdx] = msgField(1, gf);
      regCont.raw = encodeMessage(regFields);
    }
  }

  level.invalidate();
  return {
    created: newObjects.map((o) => ({ id: o.id, name: o.deco.name, prefabId: o.deco.prefabId })),
    removedDecorations: removedDecoIds.size,
    parents: parentIds.size,
    removedParents: toRemove.size,
  };
}
