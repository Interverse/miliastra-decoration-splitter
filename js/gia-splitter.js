// Interactive .gia Decoration-list splitter: pure byte-level protobuf surgery.
//
// GiaSession wraps a loaded .gia and supports repeated, user-directed splits:
// any subset of a model's Decoration entries can be moved into a newly created
// model. Serialization preserves everything that wasn't touched:
//
//   - Decoration entries are copied verbatim regardless of type or contents;
//     only the parent-model reference (component 4/40 field 502) is rewritten
//     for entries that move to a new model.
//   - New models are byte-copies of the source model (all non-Decoration
//     data is carried over) except fields that must remain unique: they get
//     a fresh guid and name, and only the moved decorations' references.
//     A node-graph binding, which may belong to one model only, stays with
//     the source model.
//   - Every entry and field the tool does not understand passes through
//     untouched, so unknown fields and future decoration types survive.
//   - Decoration ordering is preserved in both the original and the new
//     model (each keeps its entries in source-list order).
//
// If no split was performed, serialize() returns the original input bytes.

import { composeTransforms, makeParentComposer, reparentLocal, transformEq } from './transforms.js';

// the game rejects models holding more than this many Decoration entries
export const MAX_DECORATIONS_PER_MODEL = 999;

const utf8 = new TextDecoder();
const utf8enc = new TextEncoder();

// Model (object) entries come in two observed layouts:
//   class 1 (generated models): prefab wrapper = entry field 11,
//     component groups 6 (name/dec-list) and 7 (transform/collision/graph)
//   class 3 (game objects, e.g. Empty Model): wrapper = entry field 12,
//     component groups 5 and 6
// Everything else (identity, refs, name, component shapes) matches.
function modelLayout(items) {
  const wrapper = items.some((it) => it.field === 12 && it.wire === 2) && !items.some((it) => it.field === 11 && it.wire === 2) ? 12 : 11;
  return wrapper === 11
    ? { wrapper: 11, groupA: 6, groupB: 7 }
    : { wrapper: 12, groupA: 5, groupB: 6 };
}

// Errors carry an i18n code + params so the UI can localize them; the
// message itself stays English for logs and tests.
function fail(message, key, params) {
  const e = new Error(message);
  e.i18n = { key, params };
  throw e;
}

// ---------- low-level protobuf ----------

function readVarint(b, o) {
  let v = 0n, s = 0n, x;
  do { x = b[o++]; v |= BigInt(x & 127) << s; s += 7n; } while (x & 128);
  return [v, o];
}

function encVarint(v) {
  let n = BigInt(v);
  const out = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    out.push(b);
  } while (n > 0n);
  return out;
}

// Parse a message body into field items. Item value by wire type:
// 0 = BigInt, 2 = Uint8Array body, 5/1 = raw 4/8-byte Uint8Array.
function parseMsg(b) {
  const items = [];
  let o = 0;
  while (o < b.length) {
    let key; [key, o] = readVarint(b, o);
    const field = Number(key >> 3n), wire = Number(key & 7n);
    if (wire === 0) {
      let v; [v, o] = readVarint(b, o);
      items.push({ field, wire, val: v });
    } else if (wire === 2) {
      let len; [len, o] = readVarint(b, o);
      const n = Number(len);
      if (o + n > b.length) fail('Corrupt message: field overruns buffer', 'err.corrupt');
      items.push({ field, wire, val: b.subarray(o, o + n) });
      o += n;
    } else if (wire === 5) {
      items.push({ field, wire, val: b.subarray(o, o + 4) }); o += 4;
    } else if (wire === 1) {
      items.push({ field, wire, val: b.subarray(o, o + 8) }); o += 8;
    } else {
      fail(`Unsupported wire type ${wire}`, 'err.corrupt');
    }
  }
  return items;
}

function encodeMsg(items) {
  const parts = [];
  let len = 0;
  const push = (a) => { parts.push(a); len += a.length; };
  for (const it of items) {
    push(Uint8Array.from(encVarint(BigInt(it.field) << 3n | BigInt(it.wire))));
    if (it.wire === 0) push(Uint8Array.from(encVarint(it.val)));
    else if (it.wire === 2) { push(Uint8Array.from(encVarint(it.val.length))); push(it.val); }
    else push(it.val);
  }
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const readPacked = (b) => {
  const out = [];
  let o = 0;
  while (o < b.length) { let v; [v, o] = readVarint(b, o); out.push(Number(v)); }
  return out;
};

const encPacked = (nums) => {
  const bytes = [];
  for (const n of nums) bytes.push(...encVarint(n));
  return Uint8Array.from(bytes);
};

// f32 vec3 message {1:x, 2:y, 3:z}; missing components default to `dflt`
// (0 for positions/rotations, 1 for scale; the game omits zero components)
function readVec3F(b, dflt = 0) {
  const v = { x: dflt, y: dflt, z: dflt };
  for (const it of parseMsg(b)) {
    if (it.wire !== 5) continue;
    const f = new DataView(it.val.buffer, it.val.byteOffset).getFloat32(0, true);
    if (it.field === 1) v.x = f;
    else if (it.field === 2) v.y = f;
    else if (it.field === 3) v.z = f;
  }
  return v;
}

// f32 vec3 encoded the way the game writes it: zero components omitted
function encVec3F(v) {
  const items = [];
  for (const [field, val] of [[1, v.x], [2, v.y], [3, v.z]]) {
    if (val === 0) continue;
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, val, true);
    items.push({ field, wire: 5, val: b });
  }
  return encodeMsg(items);
}

// identity / reference message {2: classDomain, 3: kind, 4: guid}
// kinds seen: 1 = prefab (class-1 entry), 2 = entity (class-3 entry),
// 14 = decoration (class-28 entry); node-graph refs use classDomain 5
const KIND_DECORATION = 14;
function parseIdentity(b) {
  const id = { classDomain: null, kind: null, guid: null };
  for (const it of parseMsg(b)) {
    if (it.wire !== 0) continue;
    if (it.field === 2) id.classDomain = Number(it.val);
    else if (it.field === 3) id.kind = Number(it.val);
    else if (it.field === 4) id.guid = Number(it.val);
  }
  return id;
}
const isDecorationRef = (id) => id.classDomain === 1 && id.kind === KIND_DECORATION && id.guid != null;

function rewriteIdentityGuid(b, guid) {
  return encodeMsg(parseMsg(b).map((it) =>
    it.field === 4 && it.wire === 0 ? { field: 4, wire: 0, val: BigInt(guid) } : it));
}

// ---------- entry scanning ----------

// model (object) entry: guid, name, canonical decoration list, other refs,
// and (for the 3D viewer) the model's world position + zoom
function summarizeModel(entryBody) {
  const s = { guid: null, name: '', packed: null, refDecGuids: [], otherRefGuids: [], children: [], pos: null, rot: null, zoom: null, wrapper: 11 };
  const items = parseMsg(entryBody);
  const layout = modelLayout(items);
  s.wrapper = layout.wrapper;
  for (const it of items) {
    if (it.wire !== 2) continue;
    if (it.field === 1) s.guid = parseIdentity(it.val).guid;
    else if (it.field === 2) {
      const id = parseIdentity(it.val);
      if (isDecorationRef(id)) s.refDecGuids.push(id.guid);
      else if (id.classDomain !== 1 && id.guid != null) s.otherRefGuids.push(id.guid); // e.g. node graphs
      // other domain-1 refs (prefab / entity links of groups and entities) are
      // neither decorations nor graphs; they pass through untouched
    } else if (it.field === 3) s.name = utf8.decode(it.val);
    else if (it.field === layout.wrapper) {
      for (const p of parseMsg(it.val)) {
        if (p.field !== 1 || p.wire !== 2) continue;
        for (const c of parseMsg(p.val)) {
          if (c.wire !== 2) continue;
          if (c.field === layout.groupA) {
            const comp = parseMsg(c.val);
            const type = comp.find((x) => x.field === 1 && x.wire === 0);
            const t = type ? Number(type.val) : null;
            if (t === 40) {
              for (const body of comp) {
                if (body.wire !== 2) continue;
                for (const f of parseMsg(body.val)) {
                  if (f.field === 501 && f.wire === 2) s.packed = readPacked(f.val);
                }
              }
            } else if (t === 61) {
              // entity-group child list: {1: prefabGuid, 2: offset, 3: rot,
              // 5: guid, 6: index, 7: entityGuid} per member (field 7 is
              // present on the group entity, absent on its prefab twin)
              for (const body of comp) {
                if (body.wire !== 2) continue;
                for (const r of parseMsg(body.val)) {
                  if (r.field !== 1 || r.wire !== 2) continue;
                  const rec = { prefabGuid: null, entityGuid: null, index: null };
                  for (const f of parseMsg(r.val)) {
                    if (f.wire !== 0) continue;
                    if (f.field === 1) rec.prefabGuid = Number(f.val);
                    else if (f.field === 6) rec.index = Number(f.val);
                    else if (f.field === 7) rec.entityGuid = Number(f.val);
                  }
                  s.children.push(rec);
                }
              }
            }
          } else if (c.field === layout.groupB) {
            const comp = parseMsg(c.val);
            const type = comp.find((x) => x.field === 1 && x.wire === 0);
            if (!type || Number(type.val) !== 1) continue;
            const body = comp.find((x) => x.wire === 2);
            if (!body) continue;
            for (const f of parseMsg(body.val)) {
              if (f.wire !== 2) continue;
              if (f.field === 1) s.pos = readVec3F(f.val);
              else if (f.field === 2) s.rot = readVec3F(f.val);
              else if (f.field === 3) s.zoom = readVec3F(f.val, 1);
            }
          }
        }
      }
    }
  }
  // the dec-list component's packed list is the canonical ordering; fall back
  // to the entry's own decoration references if it is absent
  s.decGuids = s.packed ?? s.refDecGuids;
  return s;
}

// Decoration local transform parse (entry field 21 → 1 → component 5 type 1
// → body → {1: pos, 2: rot, 3: scale}, defaults 0/0/1). Returns null when the
// entry carries no transform component at all. Read for the 3D viewer and as
// the basis for reparenting recalculation; unchanged entries are never
// re-encoded from these values.
function parseDecorationTransform(entryBody) {
  for (const it of parseMsg(entryBody)) {
    if (it.field !== 21 || it.wire !== 2) continue;
    for (const p of parseMsg(it.val)) {
      if (p.field !== 1 || p.wire !== 2) continue;
      for (const c of parseMsg(p.val)) {
        if (c.field !== 5 || c.wire !== 2) continue;
        const comp = parseMsg(c.val);
        const type = comp.find((x) => x.field === 1 && x.wire === 0);
        if (!type || Number(type.val) !== 1) continue;
        const body = comp.find((x) => x.wire === 2);
        if (!body) return null;
        const t = { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
        for (const f of parseMsg(body.val)) {
          if (f.wire !== 2) continue;
          if (f.field === 1) t.pos = readVec3F(f.val);
          else if (f.field === 2) t.rot = readVec3F(f.val);
          else if (f.field === 3) t.scale = readVec3F(f.val, 1);
        }
        return t;
      }
    }
  }
  return null;
}

// non-model entry: class number + guid + name
function summarizeEntry(entryBody) {
  const e = { cls: null, guid: null, name: null };
  for (const it of parseMsg(entryBody)) {
    if (it.field === 5 && it.wire === 0) e.cls = Number(it.val);
    else if (it.field === 1 && it.wire === 2) e.guid = parseIdentity(it.val).guid;
    else if (it.field === 3 && it.wire === 2) e.name = utf8.decode(it.val);
  }
  return e;
}

// ---------- entry rebuilding ----------

// Rebuild a model entry around a new decoration list. Everything not listed
// here is emitted verbatim:
//   - identity guid + prefab-body guid   → replaced on new models
//   - entry name + component 6/1 name    → replaced on new models
//   - decoration references (field 2)    → the list's refs, in list order
//   - component 6/40 field 501           → the list's guids
//   - non-decoration references + component 7/3 graph binding → removed
//     from new models (a node graph can belong to one model only)
function rebuildModelEntry(entryBody, { chunk, allDecSet, isClone, rename = false, guid, name }) {
  const items = parseMsg(entryBody);
  const layout = modelLayout(items);

  const refByGuid = new Map();
  for (const it of items) {
    if (it.field !== 2 || it.wire !== 2) continue;
    const id = parseIdentity(it.val);
    if (isDecorationRef(id)) refByGuid.set(id.guid, it);
  }

  // decorations received from another model have no ref bytes in this
  // entry, so synthesize the standard {2:1, 3:14, 4:guid} reference
  const refFor = (g) => refByGuid.get(g) ?? { field: 2, wire: 2, val: encodeMsg([
    { field: 2, wire: 0, val: 1n },
    { field: 3, wire: 0, val: 14n },
    { field: 4, wire: 0, val: BigInt(g) },
  ]) };
  const hasDecRefs = [...refByGuid.keys()].some((g) => allDecSet.has(g));

  const out = [];
  let refsEmitted = false;
  for (const it of items) {
    if (it.field === 1 && it.wire === 2) {
      out.push(isClone ? { field: 1, wire: 2, val: rewriteIdentityGuid(it.val, guid) } : it);
      // an entry with no decoration refs of its own gets the block here,
      // right after the identity (the reference files' ref position)
      if (!hasDecRefs && chunk.length) {
        refsEmitted = true;
        for (const g of chunk) out.push(refFor(g));
      }
    } else if (it.field === 2 && it.wire === 2) {
      const id = parseIdentity(it.val);
      if (isDecorationRef(id) && allDecSet.has(id.guid)) {
        if (!refsEmitted) {
          refsEmitted = true;
          for (const g of chunk) out.push(refFor(g));
        }
        // original ref replaced by the list block above
      } else if (!isClone) {
        out.push(it); // graph/unknown references stay with the source model
      }
    } else if (it.field === 3 && it.wire === 2 && (isClone || rename)) {
      out.push({ field: 3, wire: 2, val: utf8enc.encode(name) });
    } else if (it.field === layout.wrapper && it.wire === 2) {
      out.push({ field: layout.wrapper, wire: 2, val: rebuildPrefabWrap(it.val, { chunk, isClone, rename, guid, name, layout }) });
    } else {
      out.push(it);
    }
  }
  return encodeMsg(out);
}

function rebuildPrefabWrap(wrapBody, ctx) {
  return encodeMsg(parseMsg(wrapBody).map((it) =>
    it.field === 1 && it.wire === 2
      ? { field: 1, wire: 2, val: rebuildPrefabBody(it.val, ctx) }
      : it));
}

function rebuildPrefabBody(prefabBody, { chunk, isClone, rename = false, guid, name, layout }) {
  const out = [];
  for (const it of parseMsg(prefabBody)) {
    if (it.field === 1 && it.wire === 0 && isClone) {
      out.push({ field: 1, wire: 0, val: BigInt(guid) });
    } else if (it.field === layout.groupA && it.wire === 2) {
      const comp = parseMsg(it.val);
      const type = comp.find((x) => x.field === 1 && x.wire === 0);
      const t = type ? Number(type.val) : null;
      if (t === 40) {
        // decoration guid list → this model's list (field added if absent,
        // e.g. an Empty Model whose template list component is empty)
        const rebuilt = comp.map((x) => x.wire === 2
          ? { ...x, val: encodeMsg([
              ...parseMsg(x.val).filter((f) => !(f.field === 501 && f.wire === 2)),
              ...(chunk.length ? [{ field: 501, wire: 2, val: encPacked(chunk) }] : []),
            ]) }
          : x);
        out.push({ field: layout.groupA, wire: 2, val: encodeMsg(rebuilt) });
      } else if (t === 1 && (isClone || rename)) {
        // prefab name component → the model's (new) name (other subfields kept)
        const rebuilt = comp.map((x) => x.wire === 2
          ? { ...x, val: encodeMsg(parseMsg(x.val).map((f) =>
              f.field === 1 && f.wire === 2 ? { field: 1, wire: 2, val: utf8enc.encode(name) } : f)) }
          : x);
        out.push({ field: layout.groupA, wire: 2, val: encodeMsg(rebuilt) });
      } else {
        out.push(it);
      }
    } else if (it.field === layout.groupB && it.wire === 2 && isClone) {
      const comp = parseMsg(it.val);
      const type = comp.find((x) => x.field === 1 && x.wire === 0);
      if (type && Number(type.val) === 3) {
        // node-graph binding: new models must not re-attach the source's graph
        out.push({ field: layout.groupB, wire: 2, val: encodeMsg(comp.map((x) => x.wire === 2 ? { ...x, val: new Uint8Array(0) } : x)) });
      } else {
        out.push(it);
      }
    } else {
      out.push(it);
    }
  }
  return encodeMsg(out);
}

// Rewrite a Decoration entry's parent-model reference (component 4/40 field
// 502), its name (entry field 3 + component 4/1), and/or its local transform
// (component 5/1 body fields 1/2/3, recalculated on cross-model moves so
// world placement is preserved). Every other byte of the entry survives.
function rebuildDecorationEntry(entryBody, { parent = null, name = null, transform = null }) {
  const mapComponent4 = (compBytes) => {
    const comp = parseMsg(compBytes);
    const type = comp.find((x) => x.field === 1 && x.wire === 0);
    const t = type ? Number(type.val) : null;
    if (t === 40 && parent != null) {
      return encodeMsg(comp.map((x) => x.wire === 2
        ? { ...x, val: encodeMsg(parseMsg(x.val).map((f) =>
            f.field === 502 && f.wire === 0 ? { field: 502, wire: 0, val: BigInt(parent) } : f)) }
        : x));
    }
    if (t === 1 && name != null) {
      return encodeMsg(comp.map((x) => x.wire === 2
        ? { ...x, val: encodeMsg(parseMsg(x.val).map((f) =>
            f.field === 1 && f.wire === 2 ? { field: 1, wire: 2, val: utf8enc.encode(name) } : f)) }
        : x));
    }
    return compBytes;
  };
  // transform component: replace pos/rot/scale, keep every other body field
  const mapComponent5 = (compBytes) => {
    const comp = parseMsg(compBytes);
    const type = comp.find((x) => x.field === 1 && x.wire === 0);
    if (!type || Number(type.val) !== 1) return compBytes;
    return encodeMsg(comp.map((x) => {
      if (x.wire !== 2) return x;
      const body = parseMsg(x.val);
      const out = [];
      let s1 = false, s2 = false, s3 = false;
      for (const f of body) {
        if (f.field === 1 && f.wire === 2) { out.push({ field: 1, wire: 2, val: encVec3F(transform.pos) }); s1 = true; }
        else if (f.field === 2 && f.wire === 2) { out.push({ field: 2, wire: 2, val: encVec3F(transform.rot) }); s2 = true; }
        else if (f.field === 3 && f.wire === 2) { out.push({ field: 3, wire: 2, val: encVec3F(transform.scale) }); s3 = true; }
        else out.push(f);
      }
      if (!s1) out.splice(0, 0, { field: 1, wire: 2, val: encVec3F(transform.pos) });
      if (!s2) out.splice(1, 0, { field: 2, wire: 2, val: encVec3F(transform.rot) });
      if (!s3) out.splice(2, 0, { field: 3, wire: 2, val: encVec3F(transform.scale) });
      return { ...x, val: encodeMsg(out) };
    }));
  };
  return encodeMsg(parseMsg(entryBody).map((it) => {
    if (it.field === 3 && it.wire === 2 && name != null) {
      return { field: 3, wire: 2, val: utf8enc.encode(name) };
    }
    if (it.field !== 21 || it.wire !== 2) return it;
    return { field: 21, wire: 2, val: encodeMsg(parseMsg(it.val).map((p) => {
      if (p.field !== 1 || p.wire !== 2) return p;
      return { field: 1, wire: 2, val: encodeMsg(parseMsg(p.val).map((b) => {
        if (b.field === 4 && b.wire === 2) return { field: 4, wire: 2, val: mapComponent4(b.val) };
        if (b.field === 5 && b.wire === 2 && transform != null) return { field: 5, wire: 2, val: mapComponent5(b.val) };
        return b;
      })) };
    })) };
  }));
}

// ---------- entity groups ----------
// A group export holds a class-3 group entity (top field 1) whose logic
// component 61 lists its member entities, plus a class-1 "twin" of the same
// guid in field 2 (the group's prefab definition, same child list without
// entity guids). Members are class-3 entities in field 2 that already carry
// WORLD transforms; their only link to the group is logic component 62
// {1: groupGuid, 2: prefabGuid, 3: guid, 4: index}.

// map over the logic components of a model/entity entry's prefab body;
// fn(type, compItems) returns replacement items or undefined to keep
function mapLogicComponents(entryBody, fn) {
  const items = parseMsg(entryBody);
  const layout = modelLayout(items);
  return encodeMsg(items.map((it) => {
    if (it.field !== layout.wrapper || it.wire !== 2) return it;
    return { ...it, val: encodeMsg(parseMsg(it.val).map((w) => {
      if (w.field !== 1 || w.wire !== 2) return w;
      return { ...w, val: encodeMsg(parseMsg(w.val).map((c) => {
        if (c.field !== layout.groupA || c.wire !== 2) return c;
        const comp = parseMsg(c.val);
        const type = comp.find((x) => x.field === 1 && x.wire === 0);
        const repl = fn(type ? Number(type.val) : null, comp);
        return repl ? { ...c, val: encodeMsg(repl) } : c;
      })) };
    })) };
  }));
}

// A member entity leaving its group: the membership component (62) body is
// emptied, exactly as the game's own standalone main-object exports carry it.
function buildStandaloneEntity(entryBody) {
  return mapLogicComponents(entryBody, (t, comp) => t === 62
    ? comp.map((x) => x.wire === 2 ? { ...x, val: new Uint8Array(0) } : x)
    : undefined);
}

// The group entity (or its prefab twin) with some members removed: their
// refs leave the entry's reference list and their records leave the 61
// child list. Everything else stays byte-identical.
function trimGroupEntry(entryBody, { goneEntities, gonePrefabs, isTwin }) {
  const items = parseMsg(entryBody).filter((it) => {
    if (it.field !== 2 || it.wire !== 2) return true;
    const id = parseIdentity(it.val);
    if (id.classDomain !== 1) return true;
    if (id.kind === 1 && gonePrefabs.has(id.guid)) return false;
    if (id.kind === 2 && goneEntities.has(id.guid)) return false;
    return true;
  });
  return mapLogicComponents(encodeMsg(items), (t, comp) => {
    if (t !== 61) return;
    return comp.map((x) => {
      if (x.wire !== 2 || !x.val.length) return x;
      return { ...x, val: encodeMsg(parseMsg(x.val).filter((r) => {
        if (r.field !== 1 || r.wire !== 2) return true;
        let prefab = null, entity = null;
        for (const f of parseMsg(r.val)) {
          if (f.wire !== 0) continue;
          if (f.field === 1) prefab = Number(f.val);
          else if (f.field === 7) entity = Number(f.val);
        }
        return isTwin ? !gonePrefabs.has(prefab) : !goneEntities.has(entity);
      })) };
    });
  });
}

// ---------- session ----------

export class GiaSession {
  constructor(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length < 24) fail('File is too small to be a .gia.', 'err.tooSmall');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this._magic = [dv.getUint32(4, false), dv.getUint32(8, false), dv.getUint32(12, false)];
    if (this._magic[0] !== 1 || this._magic[1] !== 806 || this._magic[2] !== 3) {
      fail(`Not a .gia file (header ${this._magic.join('/')}, expected 1/806/3).`, 'err.notGia', { header: this._magic.join('/') });
    }
    const payloadLen = dv.getUint32(16, false);
    if (20 + payloadLen > bytes.length) fail('Corrupt .gia: payload length exceeds file size.', 'err.corrupt');

    this._bytes = bytes;
    this._tail = bytes.subarray(20 + payloadLen);
    this._top = parseMsg(bytes.subarray(20, 20 + payloadLen));

    this._decNames = new Map(); // decoration guid -> entry name
    this._decT0 = new Map();    // decoration guid -> parsed local transform (or null)
    this._decT = new Map();     // decoration guid -> current effective local transform
    this._decTransformDirty = new Set(); // guids whose transform must be rewritten
    this._models = [];
    this._entities = new Map(); // class-3 entities in field 2 (group members): guid -> {topIdx, summary}
    this._twins = new Map();    // class-1 prefab twins in field 2: guid -> topIdx
    let exportTag = '', engineVersion = '';
    let decorationEntries = 0, otherEntries = 0;
    let maxGuid = 0;
    const bump = (g) => { if (g != null && g > maxGuid) maxGuid = g; };

    this._top.forEach((it, idx) => {
      if (it.wire !== 2) return;
      if (it.field === 1) {
        const s = summarizeModel(it.val);
        bump(s.guid);
        for (const g of s.decGuids) bump(g);
        this._models.push(this._modelRecord(this._models.length, idx, it.val, s));
      } else if (it.field === 2) {
        const e = summarizeEntry(it.val);
        bump(e.guid);
        if (e.cls === 28) {
          decorationEntries++;
          if (e.guid != null) {
            this._decNames.set(e.guid, e.name);
            const t = parseDecorationTransform(it.val);
            this._decT0.set(e.guid, t);
            this._decT.set(e.guid, t);
          }
        } else {
          otherEntries++;
          if (e.cls === 3 && e.guid != null) this._entities.set(e.guid, { topIdx: idx, summary: summarizeModel(it.val) });
          else if (e.cls === 1 && e.guid != null) this._twins.set(e.guid, idx);
        }
      } else if (it.field === 3) exportTag = utf8.decode(it.val);
      else if (it.field === 5) engineVersion = utf8.decode(it.val);
    });
    for (const m of this._models) this._attachGroup(m);

    this._nextGuid = maxGuid + 1;
    this._nextUid = this._models.length;
    this._decRenames = new Set(); // decoration guids whose entry needs a new name
    this.splitCount = 0;
    this.reorderCount = 0;
    this.renameCount = 0;
    this.moveCount = 0;
    this.ungroupCount = 0;
    this.meta = {
      exportName: (exportTag.match(/\\(.+)\.gia$/) || [])[1] ?? '',
      engineVersion,
      decorationEntries,
      otherEntries,
      modelsBefore: this._models.length,
    };
  }

  // live model record for a source entry (field-1 item at `topIdx`)
  _modelRecord(uid, topIdx, body, s) {
    // default zoom differs by layout: generated class-1 models use 0.1,
    // class-3 game objects (e.g. Empty Model) use 1.0
    const zd = s.wrapper === 11 ? 0.1 : 1;
    return {
      uid,
      srcTopIndex: topIdx,
      srcBody: body,
      srcAllDecSet: new Set(s.decGuids),
      srcDecGuids: s.decGuids.slice(),
      otherRefGuids: s.otherRefGuids,
      children: s.children,
      group: null,
      guid: s.guid,
      name: s.name,
      decGuids: s.decGuids.slice(),
      worldPos: s.pos ?? { x: 0, y: 0, z: 0 },
      rot: s.rot ?? { x: 0, y: 0, z: 0 },
      zoom: s.zoom ?? { x: zd, y: zd, z: zd },
      isNew: false,
    };
  }

  // A model is an entity group when its child list names entities that
  // exist in this file; members are listed in child-list order.
  _attachGroup(m) {
    const members = [];
    for (const c of m.children ?? []) {
      const ent = c.entityGuid != null ? this._entities.get(c.entityGuid) : null;
      if (ent) members.push({ guid: c.entityGuid, prefabGuid: c.prefabGuid, index: c.index });
    }
    m.group = members.length ? { members } : null;
  }

  // Display view of every model, in file order (new models follow their
  // source). `id` is the current position; `uid` is stable across splits.
  get models() {
    return this._models.map((m, id) => ({
      id,
      uid: m.uid,
      name: m.name,
      guid: m.guid,
      count: m.decGuids.length,
      isNew: m.isNew,
      hasGraph: !m.isNew && m.otherRefGuids.length > 0,
      isGroup: !!m.group,
      memberCount: m.group ? m.group.members.length : 0,
    }));
  }

  // Display view of an entity group's members, in child-list order.
  groupMembers(modelId) {
    const m = this._models[modelId];
    if (!m) fail('Unknown model.', 'err.unknownModel');
    if (!m.group) return [];
    return m.group.members.map((x, index) => {
      const ent = this._entities.get(x.guid);
      const s = ent.summary;
      return {
        index,
        guid: x.guid,
        name: s.name,
        groupIndex: x.index,
        count: s.decGuids.length,
        hasGraph: s.otherRefGuids.length > 0,
        isGroup: s.children.some((c) => c.entityGuid != null && this._entities.has(c.entityGuid)),
      };
    });
  }

  // 3D-viewer view of a group: one point per member at its (world) position.
  groupMemberPoints(modelId) {
    return this.groupMembers(modelId).map((x) => {
      const p = this._entities.get(x.guid).summary.pos ?? { x: 0, y: 0, z: 0 };
      return { index: x.index, guid: x.guid, name: x.name, x: p.x, y: p.y, z: p.z };
    });
  }

  // Move member entities out of an entity group so they become standalone
  // main objects (top-level models), placed right after the group in
  // child-list order. `memberGuids` limits the operation to those members;
  // omit it to ungroup every member. When no member remains, the group
  // entity and its prefab twin are removed from the file; otherwise both
  // keep the remaining members only. Extracted entities keep every byte
  // except the emptied group-membership component; their world placement
  // is unchanged because member transforms are stored in world space.
  // Returns {newIds, count, removedGroup}.
  ungroup(modelId, memberGuids = null) {
    const m = this._models[modelId];
    if (!m) fail('Unknown model.', 'err.unknownModel');
    if (!m.group) fail('This model is not an entity group.', 'err.notGroup');
    const want = memberGuids == null ? null : new Set([...memberGuids].map(Number));
    const extracted = m.group.members.filter((x) => !want || want.has(x.guid));
    if (!extracted.length) fail('Select at least one member entity to ungroup.', 'err.selectMember');
    const remaining = m.group.members.filter((x) => !extracted.includes(x));
    const dissolve = remaining.length === 0;
    const goneEntities = new Set(extracted.map((x) => x.guid));
    const keptPrefabs = new Set(remaining.map((x) => x.prefabGuid));
    const gonePrefabs = new Set(extracted.map((x) => x.prefabGuid).filter((g) => !keptPrefabs.has(g)));
    const twinIdx = this._twins.get(m.guid) ?? -1;
    const memberAt = new Map(extracted.map((x) => [this._entities.get(x.guid).topIdx, x]));

    // rebuild the top-level item list; indexMap translates surviving old
    // top indices to new ones, so every model's source pointer follows
    const newTop = [];
    const indexMap = new Map();
    const born = []; // {topIdx, body}
    this._top.forEach((it, idx) => {
      if (idx === m.srcTopIndex) {
        if (!dissolve) {
          const body = trimGroupEntry(it.val, { goneEntities, gonePrefabs, isTwin: false });
          indexMap.set(idx, newTop.length);
          newTop.push({ field: 1, wire: 2, val: body });
          m.srcBody = body;
        }
        for (const x of extracted) {
          const body = buildStandaloneEntity(this._top[this._entities.get(x.guid).topIdx].val);
          born.push({ topIdx: newTop.length, body });
          newTop.push({ field: 1, wire: 2, val: body });
        }
        return;
      }
      if (idx === twinIdx) {
        if (dissolve) return; // the group's prefab definition leaves with it
        indexMap.set(idx, newTop.length);
        newTop.push({ field: 2, wire: 2, val: trimGroupEntry(it.val, { goneEntities, gonePrefabs, isTwin: true }) });
        return;
      }
      if (memberAt.has(idx)) return; // now a main object (above)
      indexMap.set(idx, newTop.length);
      newTop.push(it);
    });

    // models: the dissolved group disappears, the freed members follow the
    // group's position, every other record just re-points at its entry
    const survivors = [];
    const bornRecs = new Set();
    for (const rec of this._models) {
      if (rec === m) {
        if (!dissolve) survivors.push(rec);
        for (const b of born) {
          const nm = this._modelRecord(this._nextUid++, b.topIdx, b.body, summarizeModel(b.body));
          nm.fromGroup = true;
          bornRecs.add(nm);
          survivors.push(nm);
        }
        continue;
      }
      survivors.push(rec);
    }
    for (const rec of survivors) {
      if (rec === m || bornRecs.has(rec)) continue;
      rec.srcTopIndex = indexMap.get(rec.srcTopIndex);
    }
    if (!dissolve) {
      m.srcTopIndex = indexMap.get(m.srcTopIndex);
      m.children = m.children.filter((c) => !goneEntities.has(c.entityGuid));
    }
    for (const [g, ent] of this._entities) {
      if (goneEntities.has(g)) this._entities.delete(g);
      else ent.topIdx = indexMap.get(ent.topIdx);
    }
    for (const [g, idx] of this._twins) {
      if (dissolve && idx === twinIdx) this._twins.delete(g);
      else this._twins.set(g, indexMap.get(idx));
    }
    this._top = newTop;
    this._models = survivors;
    for (const rec of this._models) this._attachGroup(rec);
    this.ungroupCount++;

    const newIds = [];
    this._models.forEach((rec, id) => { if (bornRecs.has(rec)) newIds.push(id); });
    return { newIds, count: extracted.length, removedGroup: dissolve };
  }

  // Display view of one model's Decoration list, in model order.
  decorations(modelId) {
    const m = this._models[modelId];
    return m.decGuids.map((guid, index) => ({
      index,
      guid,
      name: this._decNames.get(guid) ?? null,
    }));
  }

  // 3D-viewer view: one point per decoration, at its world position (full
  // verified composition: model pos + rot × (zoom ⊙ local pos)). Read-only:
  // display never feeds back into serialization.
  decorationPoints(modelId) {
    const m = this._models[modelId];
    if (!m) fail('Unknown model.', 'err.unknownModel');
    const compose = makeParentComposer({ pos: m.worldPos, rot: m.rot, scale: m.zoom });
    return m.decGuids.map((guid, index) => {
      const local = this._decT.get(guid);
      const p = local ? compose(local).pos : m.worldPos;
      return {
        index,
        guid,
        name: this._decNames.get(guid) ?? null,
        x: p.x,
        y: p.y,
        z: p.z,
      };
    });
  }

  get changed() {
    return this.splitCount > 0 || this.reorderCount > 0
      || this.renameCount > 0 || this.moveCount > 0 || this.ungroupCount > 0;
  }

  // Rename a model. The new name is patched into the entry (field 3 +
  // the prefab name component) at serialize time.
  renameModel(modelId, name) {
    const m = this._models[modelId];
    if (!m) fail('Unknown model.', 'err.unknownModel');
    name = String(name ?? '').trim();
    if (!name || name === m.name) return false;
    m.name = name;
    if (!m.isNew) m.renamed = true; // new models always carry their name
    this.renameCount++;
    return true;
  }

  // Rename one decoration (by its position in the model's current list).
  renameDecoration(modelId, index, name) {
    const m = this._models[modelId];
    if (!m) fail('Unknown model.', 'err.unknownModel');
    if (index < 0 || index >= m.decGuids.length) fail('Selection is out of range.', 'err.range');
    name = String(name ?? '').trim();
    const guid = m.decGuids[index];
    if (!name || name === (this._decNames.get(guid) ?? '')) return false;
    this._decNames.set(guid, name);
    this._decRenames.add(guid);
    this.renameCount++;
    return true;
  }

  // Rename every decoration at `indices` to the same name in ONE operation
  // (duplicate names are allowed by the format, so no uniqueness enforcement).
  // Returns an op token for revertRename/replayRename, enabling undo/redo.
  renameDecorationsBulk(modelId, indices, name) {
    const m = this._models[modelId];
    if (!m) fail('Unknown model.', 'err.unknownModel');
    name = String(name ?? '').trim();
    if (!name) return null;
    const picked = [...new Set(indices)].sort((a, b) => a - b);
    if (picked.length === 0) return null;
    if (picked[0] < 0 || picked[picked.length - 1] >= m.decGuids.length) {
      fail('Selection is out of range.', 'err.range');
    }
    const changes = [];
    for (const i of picked) {
      const guid = m.decGuids[i];
      changes.push({
        guid,
        prevName: this._decNames.get(guid) ?? null,
        prevRenamed: this._decRenames.has(guid),
      });
      this._decNames.set(guid, name);
      this._decRenames.add(guid);
    }
    this.renameCount++;
    return { name, changes };
  }

  // Undo a renameDecorationsBulk operation: every affected decoration gets
  // its previous name back, and entries that had never been renamed lose
  // the rename flag again (so they serialize byte-identically).
  revertRename(op) {
    for (const c of op.changes) {
      if (c.prevName == null) this._decNames.delete(c.guid);
      else this._decNames.set(c.guid, c.prevName);
      if (!c.prevRenamed) this._decRenames.delete(c.guid);
    }
    this.renameCount = Math.max(0, this.renameCount - 1);
  }

  // Redo a previously reverted rename operation.
  replayRename(op) {
    for (const c of op.changes) {
      this._decNames.set(c.guid, op.name);
      this._decRenames.add(c.guid);
    }
    this.renameCount++;
  }

  // Move the decorations at `indices` from one model to the END of another
  // model's list. Entries keep their bytes; only the parent reference is
  // rewritten at serialize time.
  moveDecorationsToModel(fromId, indices, toId) {
    const src = this._models[fromId], dst = this._models[toId];
    if (!src || !dst) fail('Unknown model.', 'err.unknownModel');
    if (fromId === toId) return null;
    const picked = [...new Set(indices)].sort((a, b) => a - b);
    if (picked.length === 0) return null;
    if (picked[0] < 0 || picked[picked.length - 1] >= src.decGuids.length) {
      fail('Selection is out of range.', 'err.range');
    }
    // reject (before touching anything) moves that would push the target
    // past the game's per-model limit; both models stay unchanged
    const total = dst.decGuids.length + picked.length;
    if (total > MAX_DECORATIONS_PER_MODEL) {
      fail(`A model can hold at most ${MAX_DECORATIONS_PER_MODEL} Decoration entries. This move would give "${dst.name}" ${total}.`,
        'err.moveLimit', { max: MAX_DECORATIONS_PER_MODEL, total, name: dst.name });
    }
    const set = new Set(picked);
    const moving = picked.map((i) => src.decGuids[i]);

    // Recompute each moved decoration's local transform relative to the new
    // model so its world placement is preserved (verified composition, see
    // js/transforms.js). No-ops when the models' transforms are identical;
    // a decoration whose recomputed transform matches its original parsed
    // values (e.g. moved away and back) returns to byte-preserving state.
    const fromT = { pos: src.worldPos, rot: src.rot, scale: src.zoom };
    const toT = { pos: dst.worldPos, rot: dst.rot, scale: dst.zoom };
    for (const g of moving) {
      const local = this._decT.get(g);
      if (!local) continue; // entry has no transform component, so nothing to rewrite
      const next = reparentLocal(local, fromT, toT);
      if (!next) continue;
      const orig = this._decT0.get(g);
      if (orig && transformEq(next, orig)) {
        this._decT.set(g, orig);
        this._decTransformDirty.delete(g);
      } else {
        this._decT.set(g, next);
        this._decTransformDirty.add(g);
      }
    }

    src.decGuids = src.decGuids.filter((_, i) => !set.has(i));
    dst.decGuids = [...dst.decGuids, ...moving];
    this.moveCount++;
    return { count: moving.length, targetName: dst.name };
  }

  // Name the next split of this model would produce.
  previewSplitName(modelId) {
    const base = this._models[modelId].name;
    const names = new Set(this._models.map((m) => m.name));
    let k = 2;
    while (names.has(`${base}_${k}`)) k++;
    return `${base}_${k}`;
  }

  // Move the decorations at `indices` (positions within the model's current
  // list) into a newly created model placed right after it. Order is
  // preserved on both sides. Returns the new model's id.
  splitModel(modelId, indices) {
    const m = this._models[modelId];
    if (!m) fail('Unknown model.', 'err.unknownModel');
    const uniq = [...new Set(indices)].sort((a, b) => a - b);
    if (uniq.length === 0) fail('Select at least one Decoration entry to split.', 'err.selectDec');
    if (uniq[0] < 0 || uniq[uniq.length - 1] >= m.decGuids.length) fail('Selection is out of range.', 'err.range');

    const picked = new Set(uniq);
    const moved = [], remaining = [];
    m.decGuids.forEach((g, i) => (picked.has(i) ? moved : remaining).push(g));

    const clone = {
      uid: this._nextUid++,
      srcTopIndex: m.srcTopIndex,
      srcBody: m.srcBody,
      srcAllDecSet: m.srcAllDecSet,
      srcDecGuids: null,
      otherRefGuids: [],
      guid: this._nextGuid++,
      name: this.previewSplitName(modelId),
      decGuids: moved,
      worldPos: m.worldPos,
      rot: m.rot,
      zoom: m.zoom,
      isNew: true,
    };
    m.decGuids = remaining;
    this._models.splice(modelId + 1, 0, clone);
    this.splitCount++;
    return modelId + 1;
  }

  // Serialize the project. `selectedUids` (array/Set of model uids) limits
  // the export to those models: unselected models are omitted along with
  // their Decoration entries and any entries (e.g. node graphs) referenced
  // only by omitted models. Everything kept is preserved exactly as the
  // full export would emit it. Omit the argument to export every model.
  // Move the decorations at `indices` (current positions) so they sit, in
  // their current relative order, starting at `targetIndex`, expressed in
  // the list as it stands AFTER the moved entries are lifted out. Only the
  // model's ordering changes; every Decoration entry keeps its bytes, so
  // all metadata stays attached to the same decoration. Returns the moved
  // block's new {start, count, changed}; a move that lands the list in the
  // same order does not mark the session changed.
  moveDecorations(modelId, indices, targetIndex) {
    const m = this._models[modelId];
    if (!m) fail('Unknown model.', 'err.unknownModel');
    const picked = [...new Set(indices)].sort((a, b) => a - b);
    if (picked.length === 0) return null;
    if (picked[0] < 0 || picked[picked.length - 1] >= m.decGuids.length) {
      fail('Selection is out of range.', 'err.range');
    }
    const set = new Set(picked);
    const moving = picked.map((i) => m.decGuids[i]);
    const rest = m.decGuids.filter((_, i) => !set.has(i));
    const at = Math.max(0, Math.min(Math.floor(targetIndex), rest.length));
    const next = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
    if (next.every((g, i) => g === m.decGuids[i])) {
      return { start: at, count: moving.length, changed: false };
    }
    m.decGuids = next;
    this.reorderCount++;
    return { start: at, count: moving.length, changed: true };
  }

  serialize(selectedUids = null) {
    const sel = selectedUids == null ? null : new Set(selectedUids);
    const included = (m) => sel === null || sel.has(m.uid);
    const models = this._models.filter(included);
    if (models.length === 0) fail('Select at least one model to export.', 'err.selectModel');
    const excludesAny = models.length !== this._models.length;

    if (!this.changed && !excludesAny) return this._bytes; // untouched input, byte for byte

    // group live models by their source entry, preserving display order
    const groups = new Map();
    for (const m of this._models) {
      if (!groups.has(m.srcTopIndex)) groups.set(m.srcTopIndex, []);
      groups.get(m.srcTopIndex).push(m);
    }

    // a decoration's parent reference is rewritten whenever its current
    // owner differs from the model that owned it in the source file (splits,
    // cross-model moves); decorations owned by an excluded model are dropped
    const origOwner = new Map();
    for (const m of this._models) {
      if (m.isNew || !m.srcDecGuids) continue;
      for (const g of m.srcDecGuids) origOwner.set(g, m.guid);
    }
    const reparent = new Map();
    const dropDec = new Set();
    for (const m of this._models) {
      if (!included(m)) {
        for (const g of m.decGuids) dropDec.add(g);
        continue;
      }
      for (const g of m.decGuids) {
        if (origOwner.get(g) !== m.guid) reparent.set(g, m.guid);
      }
    }

    const out = [];
    this._top.forEach((it, idx) => {
      if (it.field === 1 && it.wire === 2 && groups.has(idx)) {
        for (const m of groups.get(idx)) {
          if (!included(m)) continue;
          if (!m.isNew && !m.renamed && m.srcDecGuids
              && m.decGuids.length === m.srcDecGuids.length
              && m.decGuids.every((g, i) => g === m.srcDecGuids[i])) {
            out.push(it); // never touched → verbatim
          } else {
            out.push({ field: 1, wire: 2, val: rebuildModelEntry(m.srcBody, {
              chunk: m.decGuids,
              allDecSet: m.srcAllDecSet,
              isClone: m.isNew,
              rename: !!m.renamed,
              guid: m.guid,
              name: m.name,
            }) });
          }
        }
      } else if (it.field === 2 && it.wire === 2) {
        const e = summarizeEntry(it.val);
        if (e.cls === 28) {
          if (dropDec.has(e.guid)) return;
          const parent = reparent.get(e.guid) ?? null;
          const name = this._decRenames.has(e.guid) ? this._decNames.get(e.guid) : null;
          const transform = this._decTransformDirty.has(e.guid) ? this._decT.get(e.guid) : null;
          if (parent != null || name != null || transform != null) {
            out.push({ field: 2, wire: 2, val: rebuildDecorationEntry(it.val, { parent, name, transform }) });
          } else {
            out.push(it);
          }
        } else {
          // non-decoration entries (node graphs, unknown classes) are ALWAYS
          // preserved, even when every model referencing them is excluded,
          // so nothing outside the Decoration lists is ever silently lost
          out.push(it);
        }
      } else {
        out.push(it);
      }
    });

    const payload = encodeMsg(out);
    const total = 20 + payload.length + this._tail.length;
    const file = new Uint8Array(total);
    const fdv = new DataView(file.buffer);
    fdv.setUint32(0, total - 4, false);
    fdv.setUint32(4, this._magic[0], false);
    fdv.setUint32(8, this._magic[1], false);
    fdv.setUint32(12, this._magic[2], false);
    fdv.setUint32(16, payload.length, false);
    file.set(payload, 20);
    file.set(this._tail, 20 + payload.length);
    return file;
  }
}

// used by tests: parseMsg → encodeMsg must be lossless; the builders are
// exposed so tests can reproduce the game's reference files byte-for-byte
export const _internal = { parseMsg, encodeMsg };
export default { GiaSession };
