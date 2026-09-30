/**
 * model.js: structured view over a parsed .gil level.
 *
 * Only the paths needed for decoration extraction are interpreted:
 *
 *   Level (payload root)
 *     2   string  level name
 *     5   message world-object container: repeated field 1 = WorldObject
 *     6   message registry: repeated field 1 = Group
 *           Group.1 varint group id, Group.3 message tab
 *             tab.5 repeated item { 1: kind varint (200 = world object), 2: id }
 *     27  message decoration container: repeated field 2 = Decoration
 *
 *   WorldObject
 *     1  varint id (0x4040xxxx range)
 *     2  message { 1: prefab id, 2: 1 }
 *     5  repeated component (list A): { 1: type varint, <payloadField>: msg }
 *     6  repeated component (list B): { 1: type varint, <payloadField>: msg }
 *     8  varint prefab id
 *
 *   Decoration (field 27.2)
 *     1  varint id (0x4000xxxx range)
 *     2  varint prefab id
 *     4  repeated component (list A): type 1 name, type 40 { 502: parent id }
 *     5  repeated component (list B): type 1 transform, others
 *     12 unknown (observed empty)
 *
 *   Component list A type 40 payload (field 50):
 *     501 packed varints: decoration ids   (on world objects)
 *     502 varint: parent world-object id   (on decorations)
 *
 *   Transform component (list B type 1, payload field 11):
 *     1 vec3 position, 2 vec3 rotation (Euler, degrees), 3 vec3 scale,
 *     501 varint (0xffffffff on world objects)
 *   Vec3 { 1: float x, 2: float y, 3: float z }, zero components omitted.
 *
 * Everything not listed above is carried through untouched.
 */
'use strict';

import {
  parseMessage,
  encodeMessage,
  getField,
  getFields,
  fieldVarint,
  fieldString,
  fieldF32,
  decodePackedVarints,
} from './gil.js';

export const REGISTRY_KIND_WORLD_OBJECT = 200;

// Component payload field numbers, by component type, for the two component
// unions (list A appears in WorldObject.5 / Decoration.4; list B in
// WorldObject.6 / Decoration.5). Derived from the reference files.
export const COMP_A_PAYLOAD = {
  1: 11, 13: 22, 14: 23, 19: 28, 20: 29, 38: 48, 40: 50,
  52: 62, 61: 65, 62: 66, 91: 88, 111: 93,
};
export const COMP_B_PAYLOAD = {
  1: 11, 2: 12, 3: 13, 4: 14, 5: 15, 6: 16, 7: 17, 8: 18, 11: 21,
  12: 22, 16: 26, 17: 27, 19: 29, 20: 30, 22: 32,
};

/** {type, payload fields or null, field ref} for one serialized component. */
export function readComponent(compField, payloadMap) {
  const fields = parseMessage(compField.raw);
  const typeF = getField(fields, 1);
  const type = typeF && typeF.wire === 0 ? fieldVarint(typeF) : null;
  let payload = null;
  let payloadFieldNum = null;
  if (type !== null) {
    payloadFieldNum = payloadMap[type] ?? null;
    // Unknown component type: find the single non-type field, if any.
    const pf =
      payloadFieldNum !== null
        ? getField(fields, payloadFieldNum)
        : fields.find((f) => f.num !== 1 && f.wire === 2);
    if (pf) {
      payloadFieldNum = pf.num;
      payload = pf;
    }
  }
  return { type, payloadFieldNum, payload, fields, field: compField };
}

/** Parse a vec3 message ({1:x, 2:y, 3:z} floats, zeros omitted). */
export function readVec3(raw, dflt = 0) {
  const v = { x: dflt, y: dflt, z: dflt };
  if (!raw || raw.length === 0) return v;
  const fields = parseMessage(raw);
  for (const f of fields) {
    if (f.wire !== 5) continue;
    if (f.num === 1) v.x = fieldF32(f);
    else if (f.num === 2) v.y = fieldF32(f);
    else if (f.num === 3) v.z = fieldF32(f);
  }
  return v;
}

/** Extract {pos, rot, scale} from a transform component payload message. */
export function readTransform(payloadRaw) {
  const fields = parseMessage(payloadRaw);
  const posF = getField(fields, 1);
  const rotF = getField(fields, 2);
  const scaleF = getField(fields, 3);
  return {
    pos: readVec3(posF ? posF.raw : null, 0),
    rot: readVec3(rotF ? rotF.raw : null, 0),
    scale: readVec3(scaleF ? scaleF.raw : null, 1),
    fields,
  };
}

/** Read the display name from a component list (list A type 1 → {1: name}). */
function readName(compFields, payloadMap) {
  for (const cf of compFields) {
    try {
      const c = readComponent(cf, payloadMap);
      if (c.type === 1 && c.payload && c.payload.raw.length > 0) {
        const nf = getField(parseMessage(c.payload.raw), 1);
        if (nf && nf.wire === 2) return fieldString(nf);
      }
    } catch {
      /* unknown shape, ignore */
    }
  }
  return null;
}

/** Find component of a given type in serialized component fields. */
function findComponent(compFields, payloadMap, type) {
  for (const cf of compFields) {
    try {
      const c = readComponent(cf, payloadMap);
      if (c.type === type) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * Parse the payload into a level model.
 * @param {{head: Uint8Array, payload: Uint8Array, suffix: Uint8Array}} container
 */
export function parseLevel(container) {
  const root = parseMessage(container.payload);
  return new Level(container, root);
}

export class Level {
  constructor(container, root) {
    this.container = container;
    /** Top-level payload fields, in original order. */
    this.root = root;
    this._objectsCache = null;
    this._decosCache = null;
  }

  get nameField() {
    return this.root.find((f) => f.num === 2 && f.wire === 2);
  }
  get name() {
    const f = this.nameField;
    return f ? fieldString(f) : '';
  }

  /** The world-object container field (num 5). May be absent on odd files. */
  get objectContainerField() {
    return this.root.find((f) => f.num === 5 && f.wire === 2);
  }
  get decoContainerField() {
    return this.root.find((f) => f.num === 27 && f.wire === 2);
  }
  get registryContainerField() {
    return this.root.find((f) => f.num === 6 && f.wire === 2);
  }

  /** Parsed world objects: [{id, prefabId, name, decorationIds, compA, compB, fields, field}] */
  get objects() {
    if (this._objectsCache) return this._objectsCache;
    const out = [];
    const cont = this.objectContainerField;
    if (cont && cont.raw.length) {
      const fields = parseMessage(cont.raw);
      for (const f of fields) {
        if (f.num !== 1 || f.wire !== 2) continue;
        out.push(parseWorldObject(f));
      }
    }
    this._objectsCache = out;
    return out;
  }

  /** Parsed decorations: [{id, prefabId, name, parentId, fields, field}] */
  get decorations() {
    if (this._decosCache) return this._decosCache;
    const out = [];
    const cont = this.decoContainerField;
    if (cont && cont.raw.length) {
      const fields = parseMessage(cont.raw);
      for (const f of fields) {
        if (f.num !== 2 || f.wire !== 2) continue;
        out.push(parseDecoration(f));
      }
    }
    this._decosCache = out;
    return out;
  }

  invalidate() {
    this._objectsCache = null;
    this._decosCache = null;
  }

  objectById(id) {
    return this.objects.find((o) => o.id === id);
  }
  decorationById(id) {
    return this.decorations.find((d) => d.id === id);
  }

  /**
   * Registry groups that contain world-object items (kind 200).
   * Returns [{groupField, groupFields, tabField, tabFields, ids:[...]}].
   */
  registryWorldGroups() {
    const cont = this.registryContainerField;
    if (!cont || !cont.raw.length) return [];
    const out = [];
    let groups;
    try {
      groups = parseMessage(cont.raw);
    } catch {
      return [];
    }
    for (const g of groups) {
      if (g.num !== 1 || g.wire !== 2) continue;
      let gf;
      try {
        gf = parseMessage(g.raw);
      } catch {
        continue;
      }
      const tab = getField(gf, 3);
      if (!tab || tab.wire !== 2 || !tab.raw.length) continue;
      let tf;
      try {
        tf = parseMessage(tab.raw);
      } catch {
        continue;
      }
      const ids = [];
      for (const item of getFields(tf, 5)) {
        if (item.wire !== 2) continue;
        try {
          const itf = parseMessage(item.raw);
          const kindF = getField(itf, 1);
          const idF = getField(itf, 2);
          if (kindF && idF && fieldVarint(kindF) === REGISTRY_KIND_WORLD_OBJECT) {
            ids.push(fieldVarint(idF));
          }
        } catch {
          /* ignore */
        }
      }
      if (ids.length) out.push({ groupField: g, groupFields: gf, tabField: tab, tabFields: tf, ids });
    }
    return out;
  }

  /** All world-object ids known anywhere (objects + registry). */
  allWorldObjectIds() {
    const ids = new Set(this.objects.map((o) => o.id));
    for (const g of this.registryWorldGroups()) for (const id of g.ids) ids.add(id);
    return ids;
  }

  /** Serialize the payload back to bytes (root field order preserved). */
  encodePayload() {
    return encodeMessage(this.root);
  }
}

function parseWorldObject(field) {
  const fields = parseMessage(field.raw);
  const idF = getField(fields, 1);
  const id = idF && idF.wire === 0 ? fieldVarint(idF) : null;
  let prefabId = null;
  const pf = getField(fields, 2);
  if (pf && pf.wire === 2 && pf.raw.length) {
    try {
      const inner = getField(parseMessage(pf.raw), 1);
      if (inner && inner.wire === 0) prefabId = fieldVarint(inner);
    } catch {
      /* ignore */
    }
  }
  const compA = getFields(fields, 5).filter((f) => f.wire === 2);
  const compB = getFields(fields, 6).filter((f) => f.wire === 2);
  const name = readName(compA, COMP_A_PAYLOAD);

  // Decoration ids from component type 40 (payload field 50, packed 501).
  let decorationIds = [];
  const c40 = findComponent(compA, COMP_A_PAYLOAD, 40);
  if (c40 && c40.payload && c40.payload.raw.length) {
    try {
      const pf501 = getField(parseMessage(c40.payload.raw), 501);
      if (pf501 && pf501.wire === 2) decorationIds = decodePackedVarints(pf501.raw);
    } catch {
      /* ignore */
    }
  }

  // Transform (list B type 1).
  let transform = null;
  const c1 = findComponent(compB, COMP_B_PAYLOAD, 1);
  if (c1 && c1.payload && c1.payload.raw.length) {
    try {
      transform = readTransform(c1.payload.raw);
    } catch {
      /* ignore */
    }
  }

  const collision = readCollision(compB);
  return { id, prefabId, name, decorationIds, transform, collision, compA, compB, fields, field };
}

/**
 * Collision state from component list B type 5 ("PropertyStaticCollider"):
 * payload {1:1, 2:1} = collision enabled, empty payload = disabled
 * (proto3 zero-omission). Returns true/false, or null when the component is
 * absent (prefab default applies).
 */
function readCollision(compB) {
  const c5 = findComponent(compB, COMP_B_PAYLOAD, 5);
  if (!c5 || !c5.payload) return null;
  if (!c5.payload.raw.length) return false;
  try {
    const f1 = getField(parseMessage(c5.payload.raw), 1);
    return !!(f1 && f1.wire === 0 && fieldVarint(f1) !== 0);
  } catch {
    return null;
  }
}

function parseDecoration(field) {
  const fields = parseMessage(field.raw);
  const idF = getField(fields, 1);
  const id = idF && idF.wire === 0 ? fieldVarint(idF) : null;
  const prefF = getField(fields, 2);
  const prefabId = prefF && prefF.wire === 0 ? fieldVarint(prefF) : null;
  const compA = getFields(fields, 4).filter((f) => f.wire === 2);
  const compB = getFields(fields, 5).filter((f) => f.wire === 2);
  const name = readName(compA, COMP_A_PAYLOAD);

  let parentId = null;
  const c40 = findComponent(compA, COMP_A_PAYLOAD, 40);
  if (c40 && c40.payload && c40.payload.raw.length) {
    try {
      const pf502 = getField(parseMessage(c40.payload.raw), 502);
      if (pf502 && pf502.wire === 0) parentId = fieldVarint(pf502);
    } catch {
      /* ignore */
    }
  }

  let transform = null;
  const c1 = findComponent(compB, COMP_B_PAYLOAD, 1);
  if (c1 && c1.payload && c1.payload.raw.length) {
    try {
      transform = readTransform(c1.payload.raw);
    } catch {
      /* ignore */
    }
  }

  const collision = readCollision(compB);
  return { id, prefabId, name, parentId, transform, collision, compA, compB, fields, field };
}
