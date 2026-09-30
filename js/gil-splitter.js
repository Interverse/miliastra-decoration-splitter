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
  f32Field,
  encodePackedVarints,
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

  /** Object-list rows. eligible = has decorations (a valid extraction parent). */
  objects({ parentsOnly = true } = {}) {
    const rows = [];
    for (const o of this.level.objects) {
      const count = o.decorationIds.length;
      if (parentsOnly && !count) continue;
      rows.push({ id: o.id, name: o.name, prefabId: o.prefabId, count, eligible: count > 0 });
    }
    return rows;
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
