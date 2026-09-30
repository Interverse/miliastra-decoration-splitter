// GilSession: UI-facing session over the byte-preserving .gil engine
// (js/gil/). Mirrors the role GiaSession plays for .gia files: it owns the
// loaded document, exposes display views for the master/detail panels and the
// 3D viewer, orchestrates the extraction operations, and keeps exact
// byte-level undo/redo.
//
// The engine modules in js/gil/ are copied verbatim from the verified .gil
// splitter (byte-for-byte round-trip guaranteed by tools/test-gil.mjs) and
// must not be modified; everything site-specific lives here instead.
//
// Undo/redo snapshots are references to the three mutated containers' raw
// bytes (objects, registry, decorations). The engine replaces those arrays on
// mutation and never edits them in place, so snapshots are zero-copy and
// restoring one reproduces the pre-edit file byte-identically.

import {
  parseGilContainer,
  buildGilContainer,
  fieldString,
  fieldVarint,
  parseMessage,
  encodeMessage,
  msgField,
  bytesField,
  varintField,
  stringField,
  f32Field,
  encodePackedVarints,
  decodePackedVarints,
} from './gil/gil.js';
import { parseLevel, COMP_A_PAYLOAD, COMP_B_PAYLOAD, readComponent } from './gil/model.js';
import { reparentLocal, IDENTITY_TRANSFORM } from './transforms.js';
import {
  planSplit,
  applySplit,
  checkParentRemoval,
  makeParentComposer,
  MAX_SCALE,
} from './gil/split.js';

export { MAX_SCALE };

// The game rejects parents holding more than this many decorations (same
// limit as .gia models; Cozy Disc Golf's reference parents cap at exactly
// 999). Cross-parent moves are validated against it before anything mutates.
export const MAX_DECORATIONS_PER_PARENT = 999;

// vec3 encoded the way the game (and the engine) writes it: float32 fields
// {1:x, 2:y, 3:z} with zero components omitted.
function encodeVec3(v) {
  const fields = [];
  if (v.x !== 0) fields.push(f32Field(1, v.x));
  if (v.y !== 0) fields.push(f32Field(2, v.y));
  if (v.z !== 0) fields.push(f32Field(3, v.z));
  return encodeMessage(fields);
}

// ---------- prefab (entity) groups ----------
// A world object is a prefab group when its component A/61 (payload field
// 65) lists child records {1: prefab id, 2: local offset, 3: local rotation,
// 5: guid, 6: index, 7: member world-object id}. Each member carries
// component A/62 (payload field 66) {1: group id, 2: prefab id, 3: guid,
// 4: index}. This is the same layout the .gia entity groups use, and, as
// there, member transforms are stored in WORLD space. Standalone objects
// carry both components with an empty payload ({1:62, 66:{}}), which is
// exactly what a member becomes when it leaves its group. The group's own
// prefab definition lives in the prefab library (root field 4) and is a
// separate asset, so ungrouping never touches it.
const GROUP_CHILD_LIST = 61;
const GROUP_MEMBERSHIP = 62;

function findComp(list, payloadMap, type) {
  for (const cf of list) {
    try {
      const c = readComponent(cf, payloadMap);
      if (c.type === type) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}
const findCompA = (compA, type) => findComp(compA, COMP_A_PAYLOAD, type);
const findCompB = (compB, type) => findComp(compB, COMP_B_PAYLOAD, type);

// ---------- .gia export ----------
// A .gia asset is a wrap around level bytes. Verified against the game's own
// exports (every one of the 484 entries in "Furina Prefab Group.gia" is
// byte-identical to an entry of "Prefab Group.gil"; "Stone Elemental Cube As
// Decoration.gia" matches the Empty Model parents of the level fixtures):
//
//   world object (root 5)            → class-3 entity entry
//     1: { 1: {2:1 3:2 4:id}  2: refs...  3: name  5: 3
//          12: { 1: <bytes>  2: 1402  [3: kind]  4: builtin template } }
//   library prefab (root 4, field 1) → class-1 prefab entry
//     2: { 1: {2:1 3:1 4:id}  2: refs...  3: name  5: 1  11: { 1: <bytes> } }
//   decoration (root 27; field 1 = a prefab's, field 2 = a placed object's)
//     2: { 1: {2:1 3:14 4:id}  3: name  5: 28  21: { 1: <bytes> } }
//   node graph (root 10, field 1)    → class-9 graph entry
//     2: { 1: {2:5 4:guid}  3: name  5: 9  13: { 1: <bytes> } }
//
// Ids stay as they are in the level (both files use the same id spaces). An
// object placed from a library prefab brings that prefab, and a prefab brings
// its decorations, its node graph, the prefabs its group membership (A/62)
// names and its group children (A/61). A prefab group instance brings its
// member entities after all of that, in child-list order, each followed by
// its own decorations. The reference order and entry order follow the game's
// file. Only two things ever change inside an entry: a binding to a node
// graph that is missing from the level is emptied, and a decoration list
// naming ids that don't exist is trimmed to the real ones.
const GIA_HEADER_WORDS = [1, 806, 3];
const GIA_TRAILER = 1657;
const GIA_ENTITY_TAIL = 1402; // wrapper field 2 on every game-exported class-3 entry
// Export tag {uid}-{time}-{fileId}-\{name}.gia: uid and file id are read from
// the level (root fields 39 and 1) when present, else these reference values.
const GIA_TAG_UID = 600489258;
const GIA_TAG_FILE_ID = 1073742021;
const GIA_DEFAULT_VERSION = '6.7.0';
const NODE_GRAPH_BINDING = 3; // entity component whose body binds a node graph
const DECO_LIST = 40; // logic component holding the packed decoration id list (501)
const EMPTY_BYTES = new Uint8Array(0);

/** Display name from a component list's type-1 component ({1: name}). */
function compName(compA) {
  const c = findCompA(compA, 1);
  if (!c || !c.payload || !c.payload.raw.length) return null;
  try {
    const nf = parseMessage(c.payload.raw).find((f) => f.num === 1 && f.wire === 2);
    return nf ? fieldString(nf) : null;
  } catch {
    return null;
  }
}

/**
 * Links carried by a prefab body, which is what both a world object entry
 * (component lists in fields 5/6) and a library entry (fields 6/7) are:
 * template {1: prefab, 2: 1 when placed from a built-in}, decoration ids
 * (A/40 field 501), group children (A/61), group membership (A/62), the
 * node graph bound through B/3, the built-in template in the varint tail
 * (field 8 on objects, field 2 on library entries) and the kind field 9 that
 * group prefabs carry.
 */
function bodyLinks(fields, aNum, bNum) {
  const compA = getFieldsOf(fields, aNum);
  const compB = getFieldsOf(fields, bNum);
  const out = {
    name: compName(compA),
    template: null,
    placed: false,
    builtin: null,
    kind: null,
    decoIds: [],
    children: readGroupChildren(compA),
    member: null,
    graphGuid: null,
  };
  const tf = fields.find((f) => f.num === 2);
  if (tf && tf.wire === 0) {
    out.template = fieldVarint(tf);
  } else if (tf && tf.raw.length) {
    try {
      const m = parseMessage(tf.raw);
      const id = m.find((f) => f.num === 1 && f.wire === 0);
      out.template = id ? fieldVarint(id) : null;
      out.placed = m.some((f) => f.num === 2 && f.wire === 0 && fieldVarint(f) === 1);
    } catch {
      /* ignore */
    }
  }
  const b8 = fields.find((f) => f.num === 8 && f.wire === 0);
  if (b8) out.builtin = fieldVarint(b8);
  const k9 = fields.find((f) => f.num === 9 && f.wire === 0);
  if (k9) out.kind = fieldVarint(k9);
  const c40 = findCompA(compA, DECO_LIST);
  if (c40 && c40.payload && c40.payload.raw.length) {
    try {
      const pf = parseMessage(c40.payload.raw).find((f) => f.num === 501 && f.wire === 2);
      if (pf) out.decoIds = decodePackedVarints(pf.raw);
    } catch {
      /* ignore */
    }
  }
  const c62 = findCompA(compA, GROUP_MEMBERSHIP);
  if (c62 && c62.payload && c62.payload.raw.length) {
    try {
      const mf = parseMessage(c62.payload.raw);
      const v = (n) => {
        const f = mf.find((x) => x.num === n && x.wire === 0);
        return f ? fieldVarint(f) : null;
      };
      out.member = { group: v(1), prefab: v(2), guid: v(3) };
    } catch {
      /* ignore */
    }
  }
  const c3 = findCompB(compB, NODE_GRAPH_BINDING);
  if (c3 && c3.payload && c3.payload.raw.length) {
    // binding body: {1: {1: {1: 1, 2: graph guid, 501: 20000}}}
    try {
      const a = parseMessage(c3.payload.raw).find((f) => f.num === 1 && f.wire === 2);
      const b = a && parseMessage(a.raw).find((f) => f.num === 1 && f.wire === 2);
      const g = b && parseMessage(b.raw).find((f) => f.num === 2 && f.wire === 0);
      if (g) out.graphGuid = fieldVarint(g);
    } catch {
      /* ignore */
    }
  }
  return out;
}
const getFieldsOf = (fields, num) => fields.filter((f) => f.num === num && f.wire === 2);

/** Child records of a world object's group child list, in list order. */
function readGroupChildren(compA) {
  const c = findCompA(compA, GROUP_CHILD_LIST);
  if (!c || !c.payload || !c.payload.raw.length) return [];
  let pf;
  try {
    pf = parseMessage(c.payload.raw);
  } catch {
    return [];
  }
  const out = [];
  for (const rec of pf) {
    if (rec.num !== 1 || rec.wire !== 2) continue;
    let rf;
    try {
      rf = parseMessage(rec.raw);
    } catch {
      continue;
    }
    const v = (n) => {
      const f = rf.find((x) => x.num === n && x.wire === 0);
      return f ? fieldVarint(f) : null;
    };
    out.push({ prefabId: v(1), guid: v(5), index: v(6), objectId: v(7) });
  }
  return out;
}

// Depth-limited scan of one serialized message for a varint equal to `id`,
// including packed varint lists. Used to keep a dissolved group's object
// when something else in the level still points at it.
function messageMentionsId(raw, id, depth = 0) {
  if (depth > 7 || !raw.length) return false;
  let fields;
  try {
    fields = parseMessage(raw);
  } catch {
    return false;
  }
  for (const f of fields) {
    if (f.wire === 0) {
      if (fieldVarint(f) === id) return true;
    } else if (f.wire === 2 && f.raw.length) {
      if (messageMentionsId(f.raw, id, depth + 1)) return true;
      try {
        if (decodePackedVarints(f.raw).includes(id)) return true;
      } catch {
        /* not a packed list */
      }
    }
  }
  return false;
}

export class GilSession {
  constructor(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    // parseGilContainer/parseLevel throw descriptive (English) errors on
    // malformed input; the caller shows them in the load-failure dialog.
    // Nothing is committed to this session until both succeed.
    const container = parseGilContainer(bytes);
    const level = parseLevel(container);
    level.objects; // force-parse now so structural errors surface at load time
    level.decorations;

    this._bytes = bytes;
    this.container = container;
    this.level = level;
    this._undo = []; // [{label:{key,params}, snap}]
    this._redo = [];

    this.meta = {
      levelName: level.name || '',
      gameVersion: this._readVersion(),
      objectsBefore: level.objects.length,
      decorationsBefore: level.decorations.length,
    };
  }

  _readVersion() {
    const f = this.level.root.find((f) => f.num === 43 && f.wire === 2);
    try {
      return f ? fieldString(f) : null;
    } catch {
      return null;
    }
  }

  // id → decoration lookup. level.decorationById is a linear scan, which is
  // O(n²) when walking a parent's id list on large levels; this map is built
  // once per parse and keyed to the level's own cache so undo/redo (which
  // calls level.invalidate()) rebuilds it automatically.
  _decoMap() {
    const decos = this.level.decorations;
    if (this._decoMapFor !== decos) {
      this._decoMapFor = decos;
      this._decoMapCache = new Map(decos.map((d) => [d.id, d]));
    }
    return this._decoMapCache;
  }

  get changed() {
    return this._undo.length > 0;
  }
  get edits() {
    return this._undo.length;
  }
  get canUndo() {
    return this._undo.length > 0;
  }
  get canRedo() {
    return this._redo.length > 0;
  }

  // ---------- display views ----------

  /**
   * Object-list rows. eligible = has decorations (a valid extraction
   * parent). Prefab groups are listed even without decorations, since they
   * can be opened and ungrouped.
   */
  objects({ parentsOnly = true } = {}) {
    const rows = [];
    const { groups, memberOf } = this._groupMap();
    for (const o of this.level.objects) {
      const count = o.decorationIds.length;
      const members = groups.get(o.id);
      if (parentsOnly && !count && !members) continue;
      rows.push({
        id: o.id,
        name: o.name,
        prefabId: o.prefabId,
        count,
        eligible: count > 0,
        isGroup: !!members,
        memberCount: members ? members.length : 0,
        groupId: memberOf.get(o.id) ?? null,
      });
    }
    return rows;
  }

  // ---------- prefab groups ----------

  // group id -> member records (child-list order, existing objects only) and
  // member id -> group id. Built once per parse and keyed to the level's
  // object cache, so every mutation and undo/redo rebuilds it.
  _groupMap() {
    const objs = this.level.objects;
    if (this._groupMapFor !== objs) {
      const ids = new Set(objs.map((o) => o.id));
      const groups = new Map();
      const memberOf = new Map();
      for (const o of objs) {
        const kids = readGroupChildren(o.compA).filter(
          (k) => k.objectId !== null && k.objectId !== o.id && ids.has(k.objectId)
        );
        if (!kids.length) continue;
        groups.set(o.id, kids);
        for (const k of kids) memberOf.set(k.objectId, o.id);
      }
      this._groupMapFor = objs;
      this._groupMapCache = { groups, memberOf };
    }
    return this._groupMapCache;
  }

  isGroup(objectId) {
    return this._groupMap().groups.has(objectId);
  }

  /** Id of the prefab group this object belongs to, or null. */
  memberGroup(objectId) {
    return this._groupMap().memberOf.get(objectId) ?? null;
  }

  groupCount() {
    return this._groupMap().groups.size;
  }

  /** Member rows of a prefab group, in child-list order. */
  groupMembers(groupId) {
    const kids = this._groupMap().groups.get(groupId);
    if (!kids) return [];
    const { groups } = this._groupMap();
    return kids.map((k, index) => {
      const o = this.level.objectById(k.objectId);
      const nested = groups.get(k.objectId);
      return {
        index,
        id: o.id,
        name: o.name,
        prefabId: o.prefabId,
        count: o.decorationIds.length,
        collision: o.collision !== false,
        isGroup: !!nested,
        memberCount: nested ? nested.length : 0,
        groupIndex: k.index,
      };
    });
  }

  /** 3D-viewer points for a group: one per member, at its world position. */
  groupMemberPoints(groupId) {
    return this.groupMembers(groupId).map((m) => {
      const o = this.level.objectById(m.id);
      const p = o.transform ? o.transform.pos : { x: 0, y: 0, z: 0 };
      return { index: m.index, guid: m.id, name: m.name, x: p.x, y: p.y, z: p.z };
    });
  }

  /**
   * Move members out of a prefab group so they become standalone world
   * objects. `memberIds` limits the operation; omit it to free every
   * member. Members keep every byte except their emptied membership
   * component (A/62), and their world placement is unchanged because member
   * transforms are stored in world space. The group's child list (A/61)
   * drops their records. Once no member is left, the group object and its
   * registry items are removed, unless the group still holds decorations,
   * is itself a member of another group, or is referenced elsewhere among
   * the world objects or decorations; then it stays as an empty object and
   * `kept` names the reason. One undoable operation.
   * Returns {count, freedIds, removedGroup, kept}.
   */
  ungroup(groupId, memberIds = null) {
    const L = this.level;
    const group = L.objectById(groupId);
    const kids = this._groupMap().groups.get(groupId);
    if (!group || !kids) {
      const e = new Error('This object is not a prefab group.');
      e.i18n = { key: 'err.notGroup' };
      throw e;
    }
    const want = memberIds == null ? null : new Set([...memberIds].map(Number));
    const freed = kids.filter((k) => !want || want.has(k.objectId)).map((k) => k.objectId);
    if (!freed.length) {
      const e = new Error('Select at least one member to ungroup.');
      e.i18n = { key: 'err.selectMember' };
      throw e;
    }
    const freedSet = new Set(freed);
    const dissolve = freed.length === kids.length;

    // Rewrite one component's payload inside a world-object entry (fields
    // parsed as `ef`); `fn(payloadFields)` returns the new payload fields.
    const rewriteComp = (ef, type, fn) => {
      for (let j = 0; j < ef.length; j++) {
        const cf = ef[j];
        if (cf.num !== 5 || cf.wire !== 2) continue;
        let c;
        try {
          c = readComponent(cf, COMP_A_PAYLOAD);
        } catch {
          continue;
        }
        if (c.type !== type) continue;
        let payloadFields = [];
        if (c.payload && c.payload.raw.length) {
          try {
            payloadFields = parseMessage(c.payload.raw);
          } catch {
            payloadFields = [];
          }
        }
        const np = fn(payloadFields);
        const pfNum = c.payloadFieldNum ?? COMP_A_PAYLOAD[type];
        const payload = bytesField(pfNum, encodeMessage(np));
        const newComp = c.payload
          ? c.fields.map((x) => (x === c.payload ? payload : x))
          : [...c.fields, payload];
        ef[j] = msgField(5, newComp);
        return;
      }
    };
    const recordMember = (rec) => {
      try {
        const f = parseMessage(rec.raw).find((x) => x.num === 7 && x.wire === 0);
        return f ? fieldVarint(f) : null;
      } catch {
        return null;
      }
    };

    const snap = this._snapshot();
    const objCont = L.objectContainerField;
    const fields = parseMessage(objCont.raw);
    let groupIdx = -1;
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      if (f.num !== 1 || f.wire !== 2) continue;
      let ef;
      try {
        ef = parseMessage(f.raw);
      } catch {
        continue;
      }
      const idF = ef.find((x) => x.num === 1 && x.wire === 0);
      const id = idF ? fieldVarint(idF) : null;
      if (id === groupId) {
        groupIdx = i;
        rewriteComp(ef, GROUP_CHILD_LIST, (pf) =>
          pf.filter((r) => !(r.num === 1 && r.wire === 2 && freedSet.has(recordMember(r))))
        );
        fields[i] = msgField(1, ef);
      } else if (freedSet.has(id)) {
        rewriteComp(ef, GROUP_MEMBERSHIP, () => []);
        fields[i] = msgField(1, ef);
      }
    }

    // Dissolved group: drop the object unless something still needs it.
    let kept = null;
    let removed = false;
    if (dissolve) {
      if (group.decorationIds.length) kept = 'decorations';
      else if (this._groupMap().memberOf.has(groupId)) kept = 'nested';
      else {
        const others = fields.filter((f, i) => i !== groupIdx && f.wire === 2);
        const referenced =
          others.some((f) => messageMentionsId(f.raw, groupId)) ||
          (L.decoContainerField && messageMentionsId(L.decoContainerField.raw, groupId));
        if (referenced) kept = 'referenced';
      }
      if (!kept && groupIdx !== -1) {
        fields.splice(groupIdx, 1);
        removed = true;
      }
    }
    objCont.raw = encodeMessage(fields);

    // Registry: a removed group loses its world-object (kind 200) items.
    const regCont = L.registryContainerField;
    if (removed && regCont && regCont.raw.length) {
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
          const keptItems = tf.filter((item) => {
            if (item.num !== 5 || item.wire !== 2) return true;
            try {
              const itf = parseMessage(item.raw);
              const kindF = itf.find((x) => x.num === 1 && x.wire === 0);
              const idF = itf.find((x) => x.num === 2 && x.wire === 0);
              return !(kindF && idF && fieldVarint(kindF) === 200 && fieldVarint(idF) === groupId);
            } catch {
              return true;
            }
          });
          if (keptItems.length !== tf.length) {
            gf[j] = msgField(3, keptItems);
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

    L.invalidate();
    this._undo.push({ label: { key: 'gil.op.labelUngroup', params: { n: freed.length } }, snap });
    this._redo.length = 0;
    return { count: freed.length, freedIds: freed, removedGroup: removed, kept };
  }

  parentCount() {
    return this.level.objects.reduce((a, o) => a + (o.decorationIds.length ? 1 : 0), 0);
  }

  /** Decoration rows of one parent, in the parent's list order. */
  decorations(parentId) {
    const parent = this.level.objectById(parentId);
    if (!parent) return [];
    const byId = this._decoMap();
    const out = [];
    // index counts resolved decorations only, matching decorationPoints()
    for (const did of parent.decorationIds) {
      const d = byId.get(did);
      if (!d) continue;
      out.push({
        index: out.length,
        id: d.id,
        name: d.name,
        prefabId: d.prefabId,
        collision: d.collision !== false, // null (prefab default) displays as on
      });
    }
    return out;
  }

  /**
   * 3D-viewer points for one parent's decorations: composed world positions
   * (display-only; the write path recomputes transforms in the engine).
   * index matches the row index from decorations(parentId).
   */
  decorationPoints(parentId) {
    const parent = this.level.objectById(parentId);
    if (!parent) return [];
    const byId = this._decoMap();
    const compose = parent.transform ? makeParentComposer(parent.transform) : null;
    const points = [];
    let index = 0;
    for (const did of parent.decorationIds) {
      const d = byId.get(did);
      if (!d) continue;
      let p = d.transform ? d.transform.pos : { x: 0, y: 0, z: 0 };
      if (compose && d.transform) p = compose(d.transform).pos;
      points.push({ index, guid: d.id, name: d.name, x: p.x, y: p.y, z: p.z });
      index++;
    }
    return points;
  }

  // ---------- extraction ----------

  /**
   * Plan an extraction without modifying anything.
   * mode 'decos': exactly the decorations in onlyDecoIds. Their parents are
   * derived from the level itself (every object whose decoration list holds a
   * selected id), so the operation follows the decoration selection wherever
   * it lives, independent of which parents are checked or viewed.
   * mode 'parents': everything inside selectedParentIds.
   * Returns {plan, removal, parentIds} where removal is the parent-deletion
   * safety result (empty unless removeParent is requested and some parent
   * would be fully emptied).
   */
  planExtraction({ mode, selectedParentIds, onlyDecoIds = null, removeParent = false }) {
    const L = this.level;
    let parentIds;
    if (mode === 'decos') {
      parentIds = L.objects
        .filter((o) => o.decorationIds.some((d) => onlyDecoIds.has(d)))
        .map((o) => o.id);
    } else {
      parentIds = [...selectedParentIds];
    }
    const plan = planSplit(L, parentIds, mode === 'decos' ? { onlyDecoIds } : {});

    let removal = { removable: new Set(), warnings: [] };
    if (removeParent && plan.entries.length) {
      // Only parents whose ENTIRE decoration list is being extracted are
      // removal candidates; checkParentRemoval scans the level ONCE for all
      // of them (never per parent).
      const extracted = new Set(plan.entries.map((e) => e.deco.id));
      const fullyCovered = [...new Set(plan.entries.map((e) => e.parent.id))].filter((pid) => {
        const o = L.objectById(pid);
        return o && o.decorationIds.every((d) => extracted.has(d));
      });
      if (fullyCovered.length) removal = checkParentRemoval(L, fullyCovered);
    }
    return { plan, removal, parentIds };
  }

  /**
   * Apply a planned extraction (async; yields to the UI thread). Pushes an
   * undo snapshot and clears the redo stack. Returns the engine summary.
   */
  async applyExtraction({ plan, removal, label, collision, removeParent, onProgress = null }) {
    const snap = this._snapshot();
    const summary = await applySplit(this.level, plan, {
      collision,
      removeParent,
      removableParents: removal.removable,
      onProgress,
    });
    this._undo.push({ label, snap });
    this._redo.length = 0;
    return summary;
  }

  /**
   * Move the decorations at `indices` (positions in the parent's current
   * list) so they sit, in their current relative order, starting at
   * `targetIndex`, expressed in the list as it stands AFTER the moved
   * entries are lifted out (same semantics as GiaSession.moveDecorations).
   *
   * Byte-level: only the parent's decoration-id list (component A/40 packed
   * field 501) is rewritten; the decoration entries and everything else in
   * the file keep their bytes. The operation is pushed onto the shared
   * undo stack. Returns {start, count, changed} or null when nothing valid
   * was requested; a move that lands the list in the same order is not an
   * edit. Bails (null) if any listed decoration id fails to resolve, since
   * row indices would not match list positions in that (error) case.
   */
  reorderDecorations(parentId, indices, targetIndex) {
    const L = this.level;
    const parent = L.objectById(parentId);
    if (!parent) return null;
    const list = parent.decorationIds;
    const byId = this._decoMap();
    if (!list.length || !list.every((id) => byId.has(id))) return null;
    const picked = [...new Set(indices)].sort((a, b) => a - b);
    if (!picked.length) return null;
    if (picked[0] < 0 || picked[picked.length - 1] >= list.length) return null;

    const set = new Set(picked);
    const moving = picked.map((i) => list[i]);
    const rest = list.filter((_, i) => !set.has(i));
    const at = Math.max(0, Math.min(Math.floor(targetIndex), rest.length));
    const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
    if (next.every((id, i) => id === list[i])) {
      return { start: at, count: moving.length, changed: false };
    }

    // Rewrite the packed 501 list inside the parent's comp-40 component,
    // container 5; every other byte passes through verbatim. The container
    // raw is REPLACED (never edited in place) so undo snapshots stay valid.
    const snap = this._snapshot();
    const objCont = L.objectContainerField;
    const fields = parseMessage(objCont.raw);
    let done = false;
    for (let i = 0; i < fields.length && !done; i++) {
      const f = fields[i];
      if (f.num !== 1 || f.wire !== 2) continue;
      let of;
      try {
        of = parseMessage(f.raw);
      } catch {
        continue;
      }
      const idF = of.find((x) => x.num === 1 && x.wire === 0);
      if (!idF || fieldVarint(idF) !== parentId) continue;
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
        const kept = parseMessage(c.payload.raw).map((pf) =>
          pf.num === 501 && pf.wire === 2 ? bytesField(501, encodePackedVarints(next)) : pf
        );
        const newComp = c.fields.map((x) =>
          x === c.payload ? bytesField(c.payloadFieldNum, encodeMessage(kept)) : x
        );
        of[j] = msgField(5, newComp);
        fields[i] = msgField(1, of);
        done = true;
        break;
      }
    }
    if (!done) return null;
    objCont.raw = encodeMessage(fields);
    L.invalidate();
    this._undo.push({
      label: { key: 'gil.op.labelReorder', params: { n: moving.length } },
      snap,
    });
    this._redo.length = 0;
    return { start: at, count: moving.length, changed: true };
  }

  /**
   * Rename every decoration in `decoIds` to the same (trimmed) name, as ONE
   * undoable operation on the shared snapshot stack. Byte-level: only the
   * name field (field 1) inside each decoration's type-1 component payload
   * is replaced; unknown payload subfields and everything else in the file
   * survive verbatim. Decorations already carrying the name are skipped; a
   * missing name field or name component is created in the shape the engine
   * itself builds for extracted objects. Duplicate names are allowed (the
   * format has no uniqueness rule). Returns {changed} or null if nothing
   * needed changing.
   */
  renameDecorations(decoIds, name) {
    name = String(name ?? '').trim();
    if (!name) return null;
    const byId = this._decoMap();
    const targets = new Set(
      [...new Set(decoIds)].filter((id) => byId.has(id) && (byId.get(id).name ?? '') !== name)
    );
    if (!targets.size) return null;

    const snap = this._snapshot();
    const cont = this.level.decoContainerField;
    const fields = parseMessage(cont.raw);
    const nameField = { num: 1, wire: 2, raw: new TextEncoder().encode(name) };
    let changed = 0;
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      if (f.num !== 2 || f.wire !== 2) continue;
      let ef;
      try {
        ef = parseMessage(f.raw);
      } catch {
        continue;
      }
      const idF = ef.find((x) => x.num === 1 && x.wire === 0);
      if (!idF || !targets.has(fieldVarint(idF))) continue;

      let done = false;
      for (let j = 0; j < ef.length && !done; j++) {
        const cf = ef[j];
        if (cf.num !== 4 || cf.wire !== 2) continue;
        let c;
        try {
          c = readComponent(cf, COMP_A_PAYLOAD);
        } catch {
          continue;
        }
        if (c.type !== 1) continue;
        let payloadFields = [];
        if (c.payload && c.payload.raw.length) {
          try {
            payloadFields = parseMessage(c.payload.raw);
          } catch {
            payloadFields = [];
          }
        }
        let saw = false;
        const newPayload = payloadFields.map((pf) =>
          pf.num === 1 && pf.wire === 2 ? ((saw = true), nameField) : pf
        );
        if (!saw) newPayload.unshift(nameField);
        const pfNum = c.payloadFieldNum ?? COMP_A_PAYLOAD[1];
        const newComp = c.payload
          ? c.fields.map((x) => (x === c.payload ? bytesField(pfNum, encodeMessage(newPayload)) : x))
          : [...c.fields, bytesField(pfNum, encodeMessage(newPayload))];
        ef[j] = msgField(4, newComp);
        done = true;
      }
      if (!done) {
        // no name component at all: create one right after the last existing
        // component (or the prefab/id fields), matching the observed layout
        const comp = msgField(4, [
          varintField(1, 1),
          bytesField(COMP_A_PAYLOAD[1], encodeMessage([nameField])),
        ]);
        let insertAt = ef.length;
        for (let j = ef.length - 1; j >= 0; j--) {
          if (ef[j].num === 4) {
            insertAt = j + 1;
            break;
          }
          if (ef[j].num === 1 || ef[j].num === 2) {
            insertAt = j + 1;
            break;
          }
        }
        ef.splice(insertAt, 0, comp);
      }
      fields[i] = msgField(2, ef);
      changed++;
    }
    if (!changed) return null;
    cont.raw = encodeMessage(fields);
    this.level.invalidate();
    this._undo.push({ label: { key: 'gil.op.labelRename', params: { n: changed } }, snap });
    this._redo.length = 0;
    return { changed };
  }

  /**
   * Move the decorations at `indices` (positions in the source parent's
   * current list) to the END of another world object's decoration list, in
   * their current relative order. This is the .gil counterpart of
   * GiaSession.moveDecorationsToModel.
   *
   * Byte-level: rewrites the two parents' packed id lists (component A/40
   * field 501, created on the target if absent, dropped on the source when
   * emptied, matching the engine's own conventions) and each moved
   * decoration's parent back-reference (component A/40 field 502). Every
   * other byte survives. Rejects moves past MAX_DECORATIONS_PER_PARENT with
   * a localized error (err.i18n) BEFORE mutating; on success pushes one
   * undoable operation and returns {count, targetName}.
   */
  moveDecorationsToParent(fromId, indices, toId) {
    const L = this.level;
    const from = L.objectById(fromId);
    const to = L.objectById(toId);
    if (!from || !to || fromId === toId) return null;
    const list = from.decorationIds;
    const byId = this._decoMap();
    if (!list.length || !list.every((id) => byId.has(id))) return null;
    const picked = [...new Set(indices)].sort((a, b) => a - b);
    if (!picked.length) return null;
    if (picked[0] < 0 || picked[picked.length - 1] >= list.length) return null;

    const total = to.decorationIds.length + picked.length;
    if (total > MAX_DECORATIONS_PER_PARENT) {
      const e = new Error(
        `A parent object can hold at most ${MAX_DECORATIONS_PER_PARENT} decorations. ` +
          `This move would give "${to.name ?? toId}" ${total}.`
      );
      e.i18n = {
        key: 'gil.err.moveLimit',
        params: { max: MAX_DECORATIONS_PER_PARENT, total, name: to.name ?? String(toId) },
      };
      throw e;
    }

    const set = new Set(picked);
    const moving = picked.map((i) => list[i]);
    const movingSet = new Set(moving);
    const fromNext = list.filter((_, i) => !set.has(i));
    const toNext = [...to.decorationIds, ...moving];

    // Recompute each moved decoration's LOCAL transform relative to the new
    // parent so its world placement is preserved (verified composition, see
    // js/transforms.js). Computed before any mutation; null = the stored
    // transform already reproduces the same world placement (equal parent
    // transforms) and its bytes stay untouched.
    const newLocal = new Map();
    for (const did of moving) {
      const deco = byId.get(did);
      const next = reparentLocal(
        deco.transform ?? IDENTITY_TRANSFORM,
        from.transform,
        to.transform
      );
      if (next) newLocal.set(did, next);
    }

    // Rewrite (or create) a parent entry's comp-40 packed 501 list in place,
    // preserving the field's position and every unrelated byte. An empty
    // list removes the 501 field, as the engine does after extraction.
    const rewriteList = (ef, ids) => {
      for (let j = 0; j < ef.length; j++) {
        const cf = ef[j];
        if (cf.num !== 5 || cf.wire !== 2) continue;
        let c;
        try {
          c = readComponent(cf, COMP_A_PAYLOAD);
        } catch {
          continue;
        }
        if (c.type !== 40) continue;
        let payloadFields = [];
        if (c.payload && c.payload.raw.length) {
          try {
            payloadFields = parseMessage(c.payload.raw);
          } catch {
            payloadFields = [];
          }
        }
        let saw = false;
        const np = [];
        for (const pf of payloadFields) {
          if (pf.num === 501 && pf.wire === 2) {
            saw = true;
            if (ids.length) np.push(bytesField(501, encodePackedVarints(ids)));
          } else {
            np.push(pf);
          }
        }
        if (!saw && ids.length) np.push(bytesField(501, encodePackedVarints(ids)));
        const pfNum = c.payloadFieldNum ?? COMP_A_PAYLOAD[40];
        const newComp = c.payload
          ? c.fields.map((x) => (x === c.payload ? bytesField(pfNum, encodeMessage(np)) : x))
          : [...c.fields, bytesField(pfNum, encodeMessage(np))];
        ef[j] = msgField(5, newComp);
        return true;
      }
      if (!ids.length) return true;
      // object had no comp-40 at all: create one after the last component
      const comp = msgField(5, [
        varintField(1, 40),
        bytesField(COMP_A_PAYLOAD[40], encodeMessage([bytesField(501, encodePackedVarints(ids))])),
      ]);
      let at = ef.length;
      for (let j = ef.length - 1; j >= 0; j--) {
        if (ef[j].num === 5 || ef[j].num === 2 || ef[j].num === 1) {
          at = j + 1;
          break;
        }
      }
      ef.splice(at, 0, comp);
      return true;
    };

    const snap = this._snapshot();

    // ---- container 5: both parents' decoration-id lists
    const objCont = L.objectContainerField;
    const objFields = parseMessage(objCont.raw);
    let doneFrom = false;
    let doneTo = false;
    for (let i = 0; i < objFields.length && !(doneFrom && doneTo); i++) {
      const f = objFields[i];
      if (f.num !== 1 || f.wire !== 2) continue;
      let ef;
      try {
        ef = parseMessage(f.raw);
      } catch {
        continue;
      }
      const idF = ef.find((x) => x.num === 1 && x.wire === 0);
      if (!idF) continue;
      const oid = fieldVarint(idF);
      if (oid === fromId && rewriteList(ef, fromNext)) {
        objFields[i] = msgField(1, ef);
        doneFrom = true;
      } else if (oid === toId && rewriteList(ef, toNext)) {
        objFields[i] = msgField(1, ef);
        doneTo = true;
      }
    }
    if (!doneFrom || !doneTo) return null; // nothing has been assigned yet

    // ---- container 27: moved decorations' parent back-reference (502) and,
    // when the parents' transforms differ, the recomputed local transform
    const decoCont = L.decoContainerField;
    const decoFields = parseMessage(decoCont.raw);
    const parentRef = varintField(502, toId);
    for (let i = 0; i < decoFields.length; i++) {
      const f = decoFields[i];
      if (f.num !== 2 || f.wire !== 2) continue;
      let ef;
      try {
        ef = parseMessage(f.raw);
      } catch {
        continue;
      }
      const idF = ef.find((x) => x.num === 1 && x.wire === 0);
      if (!idF || !movingSet.has(fieldVarint(idF))) continue;
      const did = fieldVarint(idF);
      let done = false;
      for (let j = 0; j < ef.length && !done; j++) {
        const cf = ef[j];
        if (cf.num !== 4 || cf.wire !== 2) continue;
        let c;
        try {
          c = readComponent(cf, COMP_A_PAYLOAD);
        } catch {
          continue;
        }
        if (c.type !== 40) continue;
        let payloadFields = [];
        if (c.payload && c.payload.raw.length) {
          try {
            payloadFields = parseMessage(c.payload.raw);
          } catch {
            payloadFields = [];
          }
        }
        let saw = false;
        const np = payloadFields.map((pf) =>
          pf.num === 502 && pf.wire === 0 ? ((saw = true), parentRef) : pf
        );
        if (!saw) np.push(parentRef);
        const pfNum = c.payloadFieldNum ?? COMP_A_PAYLOAD[40];
        const newComp = c.payload
          ? c.fields.map((x) => (x === c.payload ? bytesField(pfNum, encodeMessage(np)) : x))
          : [...c.fields, bytesField(pfNum, encodeMessage(np))];
        ef[j] = msgField(4, newComp);
        done = true;
      }
      if (!done) {
        // decoration had no comp-40: create one carrying the back-reference
        const comp = msgField(4, [
          varintField(1, 40),
          bytesField(COMP_A_PAYLOAD[40], encodeMessage([parentRef])),
        ]);
        let at = ef.length;
        for (let j = ef.length - 1; j >= 0; j--) {
          if (ef[j].num === 4 || ef[j].num === 2 || ef[j].num === 1) {
            at = j + 1;
            break;
          }
        }
        ef.splice(at, 0, comp);
      }
      const tf = newLocal.get(did);
      if (tf) this._rewriteDecoTransform(ef, tf);
      decoFields[i] = msgField(2, ef);
    }

    objCont.raw = encodeMessage(objFields);
    decoCont.raw = encodeMessage(decoFields);
    L.invalidate();
    this._undo.push({
      label: { key: 'gil.op.labelMove', params: { n: moving.length } },
      snap,
    });
    this._redo.length = 0;
    return { count: moving.length, targetName: to.name };
  }

  /**
   * Replace pos/rot/scale (payload fields 1/2/3) inside a decoration entry's
   * transform component (list B type 1), preserving every other subfield,
   * the same rewrite pattern the engine uses when building extracted world
   * objects. Creates the component if the decoration had none.
   * `ef` is the decoration entry's parsed field list, mutated in place.
   */
  _rewriteDecoTransform(ef, tf) {
    const posRaw = encodeVec3(tf.pos);
    const rotRaw = encodeVec3(tf.rot);
    const scaleRaw = encodeVec3(tf.scale);
    for (let j = 0; j < ef.length; j++) {
      const cf = ef[j];
      if (cf.num !== 5 || cf.wire !== 2) continue;
      let c;
      try {
        c = readComponent(cf, COMP_B_PAYLOAD);
      } catch {
        continue;
      }
      if (c.type !== 1) continue;
      let tFields = [];
      if (c.payload && c.payload.raw.length) {
        try {
          tFields = parseMessage(c.payload.raw);
        } catch {
          tFields = [];
        }
      }
      const newT = [];
      let saw1 = false;
      let saw2 = false;
      let saw3 = false;
      for (const pf of tFields) {
        if (pf.num === 1 && pf.wire === 2) { newT.push(bytesField(1, posRaw)); saw1 = true; }
        else if (pf.num === 2 && pf.wire === 2) { newT.push(bytesField(2, rotRaw)); saw2 = true; }
        else if (pf.num === 3 && pf.wire === 2) { newT.push(bytesField(3, scaleRaw)); saw3 = true; }
        else newT.push(pf);
      }
      if (!saw1) newT.splice(0, 0, bytesField(1, posRaw));
      if (!saw2) newT.splice(1, 0, bytesField(2, rotRaw));
      if (!saw3) newT.splice(2, 0, bytesField(3, scaleRaw));
      const pfNum = c.payloadFieldNum ?? COMP_B_PAYLOAD[1];
      const newComp = c.payload
        ? c.fields.map((x) => (x === c.payload ? bytesField(pfNum, encodeMessage(newT)) : x))
        : [...c.fields, bytesField(pfNum, encodeMessage(newT))];
      ef[j] = msgField(5, newComp);
      return;
    }
    // no transform component: create one holding just pos/rot/scale
    const comp = msgField(5, [
      varintField(1, 1),
      bytesField(COMP_B_PAYLOAD[1], encodeMessage([
        bytesField(1, posRaw),
        bytesField(2, rotRaw),
        bytesField(3, scaleRaw),
      ])),
    ]);
    let at = ef.length;
    for (let j = ef.length - 1; j >= 0; j--) {
      if (ef[j].num === 5 || ef[j].num === 4 || ef[j].num === 2 || ef[j].num === 1) {
        at = j + 1;
        break;
      }
    }
    ef.splice(at, 0, comp);
  }

  // ---------- .gia export ----------

  // Everything an export can pull in besides world objects: the prefab
  // library (root 4), prefab decorations (root 27 field 1; field 2 holds
  // the placed ones the level model reads) and node graphs (root 10 field
  // 1). The library and graph containers are never edited; the decoration
  // container is, so the index follows its bytes.
  _exportIndex() {
    const R = this.level.root;
    const libF = R.find((f) => f.num === 4 && f.wire === 2) ?? null;
    const graphF = R.find((f) => f.num === 10 && f.wire === 2) ?? null;
    const decoF = this.level.decoContainerField ?? null;
    const decoRaw = decoF ? decoF.raw : null;
    const idx = this._exportIdx;
    if (idx && idx.libF === libF && idx.graphF === graphF && idx.decoRaw === decoRaw) return idx;

    const prefabs = new Map(); // id -> {id, name, raw, links}
    if (libF && libF.raw.length) {
      try {
        for (const e of parseMessage(libF.raw)) {
          if (e.num !== 1 || e.wire !== 2) continue;
          try {
            const fields = parseMessage(e.raw);
            const idF = fields.find((f) => f.num === 1 && f.wire === 0);
            if (!idF) continue;
            const links = bodyLinks(fields, 6, 7);
            prefabs.set(fieldVarint(idF), { id: fieldVarint(idF), name: links.name ?? '', raw: e.raw, links });
          } catch {
            /* unreadable entry */
          }
        }
      } catch {
        /* unreadable library */
      }
    }
    const prefabDecos = new Map(); // id -> {id, name, raw}
    if (decoRaw && decoRaw.length) {
      try {
        for (const e of parseMessage(decoRaw)) {
          if (e.num !== 1 || e.wire !== 2) continue;
          try {
            const fields = parseMessage(e.raw);
            const idF = fields.find((f) => f.num === 1 && f.wire === 0);
            if (!idF) continue;
            prefabDecos.set(fieldVarint(idF), {
              id: fieldVarint(idF),
              name: compName(getFieldsOf(fields, 4)) ?? '',
              raw: e.raw,
            });
          } catch {
            /* unreadable entry */
          }
        }
      } catch {
        /* unreadable container */
      }
    }
    const graphs = new Map(); // guid -> {guid, name, raw}
    if (graphF && graphF.raw.length) {
      try {
        for (const e of parseMessage(graphF.raw)) {
          if (e.num !== 1 || e.wire !== 2) continue;
          try {
            // entry {1: GRAPH}; GRAPH {1: {…, 5: guid}, 2: name, 3: nodes…}
            const gf = parseMessage(e.raw).find((f) => f.num === 1 && f.wire === 2);
            const graph = parseMessage(gf.raw);
            const head = parseMessage(graph.find((f) => f.num === 1 && f.wire === 2).raw);
            const guidF = head.find((f) => f.num === 5 && f.wire === 0);
            if (!guidF) continue;
            const nameF = graph.find((f) => f.num === 2 && f.wire === 2);
            graphs.set(fieldVarint(guidF), { guid: fieldVarint(guidF), name: nameF ? fieldString(nameF) : '', raw: e.raw });
          } catch {
            /* not a graph entry */
          }
        }
      } catch {
        /* unreadable container */
      }
    }
    this._exportIdx = { libF, graphF, decoRaw, prefabs, prefabDecos, graphs };
    return this._exportIdx;
  }

  /**
   * Work out what exporting `objectIds` as a .gia would contain, without
   * touching anything. Ticked objects come out in level order; a ticked
   * group brings its members (ticks on them are folded in), a ticked object
   * placed from a library prefab brings that prefab, and so on down the
   * chain. Returns {objects, items, skipped, warnings, decorations, prefabs,
   * members, graphs}:
   *   objects:  top-level entities [{id, name, ...}] (one class-3 entry each)
   *   items:    the full emission plan, in file order (used by buildGiaExport)
   *   skipped:  [{id, name, reason}] with reason 'prefabMissing'
   *   warnings: [{code: 'graphMissing' | 'decoMissing' | 'memberStandalone', params}]
   *   decorations / prefabs / members / graphs: entry counts
   */
  planGiaExport(objectIds) {
    const L = this.level;
    const idx = this._exportIndex();
    const byId = this._decoMap();
    const want = new Set([...objectIds].map(Number));

    // members of ticked groups (any depth) travel with their group
    const covered = new Set();
    const cover = (gid) => {
      for (const k of this._groupMap().groups.get(gid) ?? []) {
        if (covered.has(k.objectId)) continue;
        covered.add(k.objectId);
        cover(k.objectId);
      }
    };
    for (const id of want) if (this.isGroup(id)) cover(id);

    const objects = [];
    const items = [];
    const skipped = [];
    const warnings = [];
    const seenPrefabs = new Set();
    const seenGraphs = new Set();
    const seenEntities = new Set();
    const counts = { decorations: 0, prefabs: 0, members: 0, graphs: 0 };
    const warn = (code, params) => warnings.push({ code, params });
    const label = (name, id) => ({ name: name || String(id), id });

    const emitGraph = (guid, ownerName, ownerId) => {
      if (guid === null) return false;
      if (!idx.graphs.has(guid)) {
        warn('graphMissing', label(ownerName, ownerId));
        return false;
      }
      if (!seenGraphs.has(guid)) {
        seenGraphs.add(guid);
        counts.graphs++;
        items.push({ t: 'graph', g: idx.graphs.get(guid) });
      }
      return true;
    };
    const emitPrefab = (pid) => {
      if (pid === null || seenPrefabs.has(pid) || !idx.prefabs.has(pid)) return;
      seenPrefabs.add(pid);
      counts.prefabs++;
      const p = idx.prefabs.get(pid);
      const decoIds = p.links.decoIds.filter((d) => idx.prefabDecos.has(d));
      const missing = p.links.decoIds.length - decoIds.length;
      if (missing) warn('decoMissing', { ...label(p.name, pid), n: missing });
      const item = { t: 'prefab', p, decoIds, missing: missing > 0, graph: null };
      items.push(item);
      for (const d of decoIds) items.push({ t: 'deco', d: idx.prefabDecos.get(d) });
      counts.decorations += decoIds.length;
      if (emitGraph(p.links.graphGuid, p.name, pid)) item.graph = p.links.graphGuid;
      const m = p.links.member;
      for (const dep of m ? [m.prefab, m.guid] : []) if (dep !== pid) emitPrefab(dep);
      for (const k of p.links.children) emitPrefab(k.prefabId);
    };
    const emitEntity = (o, top, standalone) => {
      const links = bodyLinks(o.fields, 5, 6);
      const name = o.name ?? '';
      const item = { t: 'entity', o, links, name, top, standalone, decoIds: [], missing: false, graph: null };
      if (top) objects.push({ id: o.id, name, prefabId: o.prefabId, item });
      else items.push(item);
      emitPrefab(links.template);
      const m = standalone ? null : links.member;
      for (const dep of m ? [m.prefab, m.guid] : []) emitPrefab(dep);
      for (const k of links.children) emitPrefab(k.prefabId);
      item.decoIds = o.decorationIds.filter((d) => byId.has(d));
      const missing = o.decorationIds.length - item.decoIds.length;
      if (missing) warn('decoMissing', { ...label(name, o.id), n: missing });
      item.missing = missing > 0;
      for (const d of item.decoIds) items.push({ t: 'deco', d: byId.get(d) });
      counts.decorations += item.decoIds.length;
      if (emitGraph(links.graphGuid, name, o.id)) item.graph = links.graphGuid;
      for (const k of links.children) {
        const member = k.objectId !== null && k.objectId !== o.id ? L.objectById(k.objectId) : null;
        if (!member || seenEntities.has(member.id)) continue;
        seenEntities.add(member.id);
        counts.members++;
        emitEntity(member, false, false);
      }
    };

    for (const o of L.objects) {
      if (!want.has(o.id) || covered.has(o.id)) continue;
      const links = bodyLinks(o.fields, 5, 6);
      const name = o.name ?? '';
      if (links.template !== null && !links.placed && !idx.prefabs.has(links.template)) {
        skipped.push({ id: o.id, name, reason: 'prefabMissing' });
        continue;
      }
      const standalone = this.memberGroup(o.id) !== null;
      if (standalone) warn('memberStandalone', label(name, o.id));
      seenEntities.add(o.id);
      emitEntity(o, true, standalone);
    }
    return { objects, items, skipped, warnings, ...counts };
  }

  /**
   * Write a planned export as a complete .gia file. `name` becomes the asset
   * name in the export tag. The level is not modified and nothing lands on
   * the undo stack.
   */
  buildGiaExport(plan, { name = 'export', timestamp = Math.floor(Date.now() / 1000), uid = null, fileId = null } = {}) {
    if (!plan.objects.length) {
      const e = new Error('None of the chosen objects can be exported as a .gia.');
      e.i18n = { key: 'gil.export.none' };
      throw e;
    }
    const idx = this._exportIndex();
    const identity = (kind, id) => msgField(1, [varintField(2, 1), varintField(3, kind), varintField(4, id)]);
    const ref = (kind, id) => msgField(2, [varintField(2, 1), varintField(3, kind), varintField(4, id)]);
    const graphRef = (guid) => msgField(2, [varintField(2, 5), varintField(4, guid)]);
    const inLib = (id) => id !== null && idx.prefabs.has(id);

    const entityEntry = (x) => {
      const o = x.o;
      const l = x.links;
      // game order: template prefab, decorations, membership prefabs,
      // child prefab/entity pairs, node graph
      const refs = [];
      if (inLib(l.template)) refs.push(ref(1, l.template));
      for (const d of x.decoIds) refs.push(ref(14, d));
      const m = x.standalone ? null : l.member;
      for (const dep of m ? [m.prefab, m.guid] : []) if (inLib(dep)) refs.push(ref(1, dep));
      for (const k of l.children) {
        if (inLib(k.prefabId)) refs.push(ref(1, k.prefabId));
        if (k.objectId !== null && k.objectId !== o.id && this.level.objectById(k.objectId)) refs.push(ref(2, k.objectId));
      }
      if (x.graph !== null) refs.push(graphRef(x.graph));
      const wrap = [bytesField(1, this._giaEntityBody(x)), varintField(2, GIA_ENTITY_TAIL)];
      const kind = inLib(l.template) ? idx.prefabs.get(l.template).links.kind : null;
      if (kind !== null) wrap.push(varintField(3, kind));
      const builtin = l.builtin ?? o.prefabId;
      if (builtin !== null) wrap.push(varintField(4, builtin));
      return msgField(x.top ? 1 : 2, [identity(2, o.id), ...refs, stringField(3, x.name), varintField(5, 3), msgField(12, wrap)]);
    };
    const prefabEntry = (x) => {
      const l = x.p.links;
      const refs = x.decoIds.map((d) => ref(14, d));
      const m = l.member;
      for (const dep of m ? [m.prefab, m.guid] : []) if (inLib(dep)) refs.push(ref(1, dep));
      for (const k of l.children) if (inLib(k.prefabId)) refs.push(ref(1, k.prefabId));
      if (x.graph !== null) refs.push(graphRef(x.graph));
      return msgField(2, [identity(1, x.p.id), ...refs, stringField(3, x.p.name), varintField(5, 1), msgField(11, [bytesField(1, this._giaPrefabBody(x))])]);
    };
    const decoEntry = (d) => msgField(2, [identity(14, d.id), stringField(3, d.name ?? ''), varintField(5, 28), msgField(21, [bytesField(1, d.field ? d.field.raw : d.raw)])]);
    const graphEntry = (g) => msgField(2, [
      msgField(1, [varintField(2, 5), varintField(4, g.guid)]),
      stringField(3, g.name),
      varintField(5, 9),
      msgField(13, [bytesField(1, g.raw)]),
    ]);

    const top = plan.objects.map((x) => entityEntry(x.item));
    for (const it of plan.items) {
      if (it.t === 'entity') top.push(entityEntry(it));
      else if (it.t === 'prefab') top.push(prefabEntry(it));
      else if (it.t === 'deco') top.push(decoEntry(it.d));
      else if (it.t === 'graph') top.push(graphEntry(it.g));
    }
    const rootVarint = (num) => {
      const f = this.level.root.find((x) => x.num === num && x.wire === 0);
      return f ? fieldVarint(f) : null;
    };
    const tagUid = uid ?? rootVarint(39) ?? GIA_TAG_UID;
    const tagFile = fileId ?? rootVarint(1) ?? rootVarint(52) ?? GIA_TAG_FILE_ID;
    top.push(stringField(3, `${tagUid}-${timestamp}-${tagFile}-\\${name}.gia`));
    top.push(stringField(5, this.meta.gameVersion || GIA_DEFAULT_VERSION));

    const payload = encodeMessage(top);
    const out = new Uint8Array(24 + payload.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, out.length - 4);
    GIA_HEADER_WORDS.forEach((w, i) => dv.setUint32(4 + 4 * i, w));
    dv.setUint32(16, payload.length);
    out.set(payload, 20);
    dv.setUint32(20 + payload.length, GIA_TRAILER);
    return out;
  }

  // An entry's own bytes, verbatim unless something has to give: a binding
  // to a node graph that is not in the level is emptied, a decoration list
  // naming ids that don't exist is trimmed to the real ones, and a member
  // exported without its group loses its membership (A/62 emptied), the
  // way the game writes standalone objects. `aNum`/`bNum` name the
  // component list fields (5/6 on objects, 6/7 on library prefabs).
  _giaBody(raw, aNum, bNum, links, { decoIds, missing, dropGraph, dropMember }) {
    if (!missing && !dropGraph && !dropMember) return raw;
    const ef = parseMessage(raw);
    for (let j = 0; j < ef.length; j++) {
      const cf = ef[j];
      if (cf.wire !== 2 || (cf.num !== aNum && cf.num !== bNum)) continue;
      let c;
      try {
        c = readComponent(cf, cf.num === aNum ? COMP_A_PAYLOAD : COMP_B_PAYLOAD);
      } catch {
        continue;
      }
      if (!c.payload) continue;
      const replace = (payload) => msgField(cf.num, c.fields.map((f) => (f === c.payload ? payload : f)));
      if (cf.num === bNum && dropGraph && c.type === NODE_GRAPH_BINDING) {
        ef[j] = replace(bytesField(c.payloadFieldNum, EMPTY_BYTES));
      } else if (cf.num === aNum && dropMember && c.type === GROUP_MEMBERSHIP) {
        ef[j] = replace(bytesField(c.payloadFieldNum, EMPTY_BYTES));
      } else if (cf.num === aNum && missing && c.type === DECO_LIST && c.payload.raw.length) {
        const np = [];
        for (const pf of parseMessage(c.payload.raw)) {
          if (pf.num === 501 && pf.wire === 2) {
            if (decoIds.length) np.push(bytesField(501, encodePackedVarints(decoIds)));
          } else {
            np.push(pf);
          }
        }
        ef[j] = replace(bytesField(c.payloadFieldNum, encodeMessage(np)));
      }
    }
    return encodeMessage(ef);
  }
  _giaEntityBody(x) {
    return this._giaBody(x.o.field.raw, 5, 6, x.links, {
      decoIds: x.decoIds,
      missing: x.missing,
      dropGraph: x.links.graphGuid !== null && x.graph === null,
      dropMember: x.standalone && x.links.member !== null,
    });
  }
  _giaPrefabBody(x) {
    return this._giaBody(x.p.raw, 6, 7, x.p.links, {
      decoIds: x.decoIds,
      missing: x.missing,
      dropGraph: x.p.links.graphGuid !== null && x.graph === null,
      dropMember: false,
    });
  }

  // ---------- undo / redo (exact byte-level state) ----------

  _snapshot() {
    const grab = (f) => (f ? f.raw : null);
    return {
      obj: grab(this.level.objectContainerField),
      reg: grab(this.level.registryContainerField),
      deco: grab(this.level.decoContainerField),
    };
  }

  _restore(snap) {
    const put = (f, raw) => {
      if (f && raw !== null) f.raw = raw;
    };
    put(this.level.objectContainerField, snap.obj);
    put(this.level.registryContainerField, snap.reg);
    put(this.level.decoContainerField, snap.deco);
    this.level.invalidate();
  }

  /** Undo the latest operation; returns its label, or null. */
  undo() {
    const op = this._undo.pop();
    if (!op) return null;
    const current = this._snapshot();
    this._restore(op.snap);
    this._redo.push({ label: op.label, snap: current });
    return op.label;
  }

  /** Redo the latest undone operation; returns its label, or null. */
  redo() {
    const op = this._redo.pop();
    if (!op) return null;
    const current = this._snapshot();
    this._restore(op.snap);
    this._undo.push({ label: op.label, snap: current });
    return op.label;
  }

  // ---------- output ----------

  /** Serialized file; the original input bytes when nothing was changed. */
  serialize() {
    if (!this.changed) return this._bytes;
    return buildGilContainer(
      this.container.head,
      this.level.encodePayload(),
      this.container.suffix
    );
  }
}

export default { GilSession };
