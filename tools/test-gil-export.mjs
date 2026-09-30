/**
 * Node test harness for exporting .gil world objects as a .gia asset
 * (GilSession.planGiaExport / buildGiaExport in js/gil-splitter.js). Run:
 *   node tools/test-gil-export.mjs [reference-dir]
 * The output is checked against the game's own exports: "Stone Elemental
 * Cube As Decoration.gia" (an Empty Model with one decoration, the kind of
 * object the level fixtures hold) for the entry layout, and, when "Prefab
 * Group.gil" and "Furina Prefab Group.gia" are both present, byte identity
 * between the tool's export of the placed group and the game's file. Every
 * export is loaded back with the .gia engine (GiaSession) and the
 * independent legacy parser, and verified to keep names, ids, bytes and
 * world placement.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseGilContainer,
  buildGilContainer,
  parseMessage,
  encodeMessage,
  getField,
  fieldVarint,
  fieldString,
  bytesField,
  msgField,
  varintField,
  encodePackedVarints,
  decodePackedVarints,
} from '../js/gil/gil.js';
import { parseLevel, COMP_A_PAYLOAD, COMP_B_PAYLOAD, readComponent } from '../js/gil/model.js';
import { GilSession } from '../js/gil-splitter.js';
import { GiaSession } from '../js/gia-splitter.js';
import { parseGia } from './gia-parser.js';

const here = dirname(fileURLToPath(import.meta.url));
const REF = process.argv[2] ?? join(here, '..', 'reference', 'reference-samples');

let failures = 0;
function check(cond, label) {
  if (cond) console.log('  ok  ' + label);
  else {
    failures++;
    console.error('  FAIL ' + label);
  }
}
const load = (name) => new Uint8Array(readFileSync(join(REF, name)));
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const near = (a, b) => Math.abs(a - b) < 1e-6;

// field numbers of a message, runs of a repeated field collapsed to one
const shape = (raw) => parseMessage(raw).map((f) => f.num).filter((n, i, a) => i === 0 || a[i - 1] !== n);
const varints = (raw) => Object.fromEntries(parseMessage(raw).filter((f) => f.wire === 0).map((f) => [f.num, fieldVarint(f)]));
const refsOf = (entryFields) => entryFields.filter((f) => f.num === 2).map((f) => varints(f.raw));
const refStr = (r) => `${r[2]}/${r[3] ?? '-'}:${r[4]}`;
function giaParts(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const words = [0, 4, 8, 12, 16].map((o) => dv.getUint32(o));
  const payload = bytes.subarray(20, 20 + words[4]);
  return {
    words,
    payload,
    top: parseMessage(payload),
    tailLen: bytes.length - 20 - words[4],
    tail: dv.getUint32(20 + words[4]),
  };
}
// number of top-level fields that differ between two entry bodies, and which
const bodyDiff = (a, b) => {
  const fa = parseMessage(a);
  const fb = parseMessage(b);
  const out = [];
  for (let i = 0; i < Math.max(fa.length, fb.length); i++) {
    const x = fa[i];
    const y = fb[i];
    if (x && y && x.num === y.num && x.wire === y.wire && same(x.raw, y.raw)) continue;
    out.push({ i, a: x, b: y });
  }
  return out;
};
const compType = (f, map) => {
  try {
    return readComponent(f, map).type;
  } catch {
    return null;
  }
};
// rewrite one world object entry of a level container in place
function patchObject(objFields, id, fn) {
  for (let i = 0; i < objFields.length; i++) {
    const f = objFields[i];
    if (f.num !== 1 || f.wire !== 2) continue;
    const ef = parseMessage(f.raw);
    const idF = getField(ef, 1);
    if (!idF || fieldVarint(idF) !== id) continue;
    fn(ef);
    objFields[i] = msgField(1, ef);
    return objFields[i].raw;
  }
  return null;
}
const REF_GIA = giaParts(load('Stone Elemental Cube As Decoration.gia'));
const PARENT = 1077936136; // "Empty Model" holding 3 decorations in the level fixtures
const TEMPLATE_OBJ = 1086324737; // "Default Template", placed from the level's prefab library
const EXAMPLE_GRAPH = 1073741825; // "Example Graph" in the level fixtures' graph container

// ------------------------------------------------- 1. one parent, three decorations
console.log('== export: Level With 1 Decoration');
{
  const s = new GilSession(load('Level With 1 Decoration.gil'));
  const parent = s.level.objectById(PARENT);
  const plan = s.planGiaExport([PARENT]);
  check(plan.objects.length === 1 && plan.skipped.length === 0 && plan.warnings.length === 0, 'plan: one object, nothing skipped, no warnings');
  check(plan.decorations === 3 && plan.prefabs === 0 && plan.graphs === 0 && plan.members === 0, 'plan counts: 3 decorations, no prefabs, graphs or members');
  check(same(plan.objects[0].item.decoIds, parent.decorationIds), 'plan lists the parent’s 3 decorations in list order');

  const out = s.buildGiaExport(plan, { name: 'Empty Model', timestamp: 1234567890 });
  check(!s.changed && s.edits === 0, 'exporting leaves the level untouched (no undo entry)');
  const g = giaParts(out);
  check(g.words[0] === out.length - 4, 'container: first word is file length - 4');
  check(g.words[1] === 1 && g.words[2] === 806 && g.words[3] === 3, 'container: header words 1 / 806 / 3');
  check(g.words[4] === g.payload.length && g.tailLen === 4 && g.tail === 1657, 'container: payload length and 1657 trailer');
  check(same(g.words.slice(1, 4), REF_GIA.words.slice(1, 4)) && g.tail === REF_GIA.tail, 'container matches the game export');

  // top level: objects, decorations, export tag, version
  check(same(shape(g.payload), shape(REF_GIA.payload)) && same(shape(g.payload), [1, 2, 3, 5]), 'top-level layout matches the game export (1, 2…, 3, 5)');
  const tag = fieldString(getField(g.top, 3));
  check(tag === '600489258-1234567890-1073742021-\\Empty Model.gia', `export tag: ${tag}`);
  check(fieldString(getField(g.top, 5)) === s.meta.gameVersion, `engine version taken from the level (${s.meta.gameVersion})`);

  // the object entry
  const obj = parseMessage(g.top[0].raw);
  const refObj = parseMessage(REF_GIA.top[0].raw);
  check(same(shape(g.top[0].raw), shape(REF_GIA.top[0].raw)) && same(shape(g.top[0].raw), [1, 2, 3, 5, 12]), 'object entry layout matches the game export (identity, refs, name, class, wrapper)');
  const idn = varints(getField(obj, 1).raw);
  const refIdn = varints(getField(refObj, 1).raw);
  check(idn[2] === refIdn[2] && idn[3] === refIdn[3] && idn[4] === PARENT, `identity {2:${idn[2]} 3:${idn[3]} 4:id} as in the game export, id kept from the level`);
  const refs = refsOf(obj);
  check(refs.length === 3 && refs.every((r) => r[2] === 1 && r[3] === 14) && same(refs.map((r) => r[4]), parent.decorationIds), 'one {2:1 3:14 4:id} reference per decoration, in list order');
  check(fieldString(getField(obj, 3)) === 'Empty Model' && fieldVarint(getField(obj, 5)) === 3, 'entry name and class 3');
  const wrap = parseMessage(getField(obj, 12).raw);
  const refWrap = parseMessage(getField(refObj, 12).raw);
  check(same(shape(getField(obj, 12).raw), shape(getField(refObj, 12).raw)) && same(shape(getField(obj, 12).raw), [1, 2, 4]), 'wrapper layout matches (body, 1402, prefab)');
  check(fieldVarint(getField(wrap, 2)) === fieldVarint(getField(refWrap, 2)) && fieldVarint(getField(wrap, 2)) === 1402, 'wrapper field 2 = 1402 as in the game export');
  check(fieldVarint(getField(wrap, 4)) === parent.prefabId && parent.prefabId === 10005018, 'wrapper field 4 = the object’s built-in template');
  check(same(getField(wrap, 1).raw, parent.field.raw), 'object body is the world object’s bytes, verbatim');
  check(same(shape(getField(wrap, 1).raw), shape(getField(refWrap, 1).raw)), 'object body layout matches the game export’s prefab body');

  // the decoration entries
  const decos = g.top.filter((f) => f.num === 2);
  check(decos.length === 3, 'three decoration entries');
  const refDeco = parseMessage(REF_GIA.top.find((f) => f.num === 2).raw);
  parent.decorationIds.forEach((did, i) => {
    const d = s.level.decorationById(did);
    const e = parseMessage(decos[i].raw);
    check(same(shape(decos[i].raw), shape(REF_GIA.top.find((f) => f.num === 2).raw)) && same(shape(decos[i].raw), [1, 3, 5, 21]), `decoration ${i}: entry layout matches the game export`);
    const di = varints(getField(e, 1).raw);
    const refDi = varints(getField(refDeco, 1).raw);
    check(di[2] === refDi[2] && di[3] === refDi[3] && di[4] === did, `decoration ${i}: identity {2:1 3:14 4:id}, id kept`);
    check(fieldString(getField(e, 3)) === d.name && fieldVarint(getField(e, 5)) === 28, `decoration ${i}: name "${d.name}" and class 28`);
    const wrap21 = parseMessage(getField(e, 21).raw);
    check(wrap21.length === 1 && wrap21[0].num === 1 && same(wrap21[0].raw, d.field.raw), `decoration ${i}: body is the level entry’s bytes, verbatim`);
  });

  // load it back with the .gia engine
  const gia = new GiaSession(out);
  check(gia.models.length === 1 && gia.models[0].name === 'Empty Model' && gia.models[0].count === 3, 'GiaSession: one model "Empty Model" with 3 decorations');
  check(same(gia.decorations(0).map((d) => d.guid), parent.decorationIds), 'GiaSession: decoration order matches the level');
  check(same(gia.decorations(0).map((d) => d.name), parent.decorationIds.map((id) => s.level.decorationById(id).name)), 'GiaSession: decoration names carried over');
  check(same(gia.serialize(), out) && !gia.changed, 'GiaSession: untouched re-serialize is byte-identical');
  const gilPts = s.decorationPoints(PARENT);
  const giaPts = gia.decorationPoints(0);
  check(
    gilPts.length === giaPts.length && gilPts.every((p, i) => near(p.x, giaPts[i].x) && near(p.y, giaPts[i].y) && near(p.z, giaPts[i].z)),
    'GiaSession: world positions equal the level’s composed positions'
  );
  // a split on the exported file works, so refs and lists agree
  gia.splitModel(0, [1]);
  const again = new GiaSession(gia.serialize());
  check(again.models.length === 2 && again.models[0].count === 2 && again.models[1].count === 1, 'GiaSession: splitting the export works (2 + 1)');

  // independent legacy parser
  const legacy = parseGia(out);
  check(legacy.objects.length === 1 && legacy.objects[0].guid === PARENT, 'legacy parser: object found with the level id');
  check(legacy.decorations.length === 3 && legacy.decorations.every((d) => d.ownerGuid === PARENT && d.ownerIndex === 0), 'legacy parser: 3 decorations, all owned by the object');
  check(legacy.exportName === 'Empty Model' && legacy.engineVersion === s.meta.gameVersion, 'legacy parser: export name and version');
}

// --------------------------------------------- 2. two parents, six decorations
console.log('== export: Level With 2 Decorations');
{
  const s = new GilSession(load('Level With 2 Decorations.gil'));
  const ids = [1077936138, PARENT]; // deliberately not in level order
  const plan = s.planGiaExport(ids);
  const levelOrder = s.level.objects.filter((o) => ids.includes(o.id)).map((o) => o.id);
  check(same(plan.objects.map((x) => x.id), levelOrder), 'objects come out in level order');
  check(plan.decorations === 6, '6 decorations in total');
  const out = s.buildGiaExport(plan, { name: 'Two', timestamp: 1 });
  const g = giaParts(out);
  check(g.top.filter((f) => f.num === 1).length === 2 && g.top.filter((f) => f.num === 2).length === 6, '2 object entries, 6 decoration entries');
  const allIds = g.top.filter((f) => f.wire === 2 && (f.num === 1 || f.num === 2)).map((f) => varints(getField(parseMessage(f.raw), 1).raw)[4]);
  check(new Set(allIds).size === allIds.length, 'every entry id is unique');
  const gia = new GiaSession(out);
  check(gia.models.length === 2 && same(gia.models.map((m) => m.guid), levelOrder), 'GiaSession: both models, level order');
  for (const m of gia.models) {
    const o = s.level.objectById(m.guid);
    check(same(gia.decorations(m.id).map((d) => d.guid), o.decorationIds), `GiaSession: "${m.name}" keeps its ${o.decorationIds.length} decorations`);
    const a = s.decorationPoints(o.id);
    const b = gia.decorationPoints(m.id);
    check(a.every((p, i) => near(p.x, b[i].x) && near(p.y, b[i].y) && near(p.z, b[i].z)), `GiaSession: "${m.name}" world positions match`);
  }
  // moving a decoration across the two exported models works too
  gia.moveDecorationsToModel(0, [0], 1);
  const again = new GiaSession(gia.serialize());
  check(again.models[0].count === 2 && again.models[1].count === 4, 'GiaSession: cross-model move on the export re-parses (2 + 4)');
}

// ------------------------------------ 3. object placed from a library prefab
console.log('== export: object placed from a library prefab');
{
  const s = new GilSession(load('Level With 1 Decoration.gil'));
  const idx = s._exportIndex();
  const tmpl = s.level.objectById(TEMPLATE_OBJ);
  check(!!tmpl && idx.prefabs.has(TEMPLATE_OBJ), 'fixture: "Default Template" is placed from a library prefab of the same id');
  const plan = s.planGiaExport([TEMPLATE_OBJ]);
  check(plan.objects.length === 1 && plan.skipped.length === 0 && plan.warnings.length === 0, 'plan: exportable, nothing skipped, no warnings');
  check(plan.prefabs === 1 && plan.decorations === 0 && plan.items.length === 1 && plan.items[0].t === 'prefab' && plan.items[0].p.id === TEMPLATE_OBJ, 'plan: the prefab comes along');

  const out = s.buildGiaExport(plan, { name: 'Default Template', timestamp: 1 });
  const g = giaParts(out);
  check(same(shape(g.payload), [1, 2, 3, 5]) && g.top[0].num === 1 && g.top[1].num === 2, 'entity in field 1, prefab in field 2');
  const ent = parseMessage(g.top[0].raw);
  const refs = refsOf(ent);
  check(refs.length === 1 && refStr(refs[0]) === `1/1:${TEMPLATE_OBJ}`, 'entity references its prefab {2:1 3:1 4:id}');
  const wrap = parseMessage(getField(ent, 12).raw);
  check(fieldVarint(getField(wrap, 2)) === 1402 && fieldVarint(getField(wrap, 4)) === 1000000 && !getField(wrap, 3), 'wrapper: 1402, built-in template from the body (1000000), no kind field');
  check(same(getField(wrap, 1).raw, tmpl.field.raw), 'entity body verbatim');
  const pre = parseMessage(g.top[1].raw);
  check(fieldVarint(getField(pre, 5)) === 1 && same(shape(g.top[1].raw), [1, 3, 5, 11]), 'prefab entry: class 1 with identity, name, class, wrapper 11');
  const pid = varints(getField(pre, 1).raw);
  check(pid[2] === 1 && pid[3] === 1 && pid[4] === TEMPLATE_OBJ, 'prefab identity {2:1 3:1 4:id}');
  check(fieldString(getField(pre, 3)) === 'Default Template', 'prefab entry named after the library entry');
  const w11 = parseMessage(getField(pre, 11).raw);
  check(w11.length === 1 && w11[0].num === 1 && same(w11[0].raw, idx.prefabs.get(TEMPLATE_OBJ).raw), 'prefab body is the library entry’s bytes, verbatim');
  const gia = new GiaSession(out);
  check(gia.models.length === 1 && gia.models[0].name === 'Default Template' && gia.models[0].count === 0, 'GiaSession loads the entity as a model');
  check(same(gia.serialize(), out), 'GiaSession: untouched re-serialize is byte-identical');
}

// ------------------------------------------------ 4. empty objects, empty plans
console.log('== export: decoration-less objects and empty plans');
{
  const s = new GilSession(load('Level With 1 Decoration.gil'));
  const stage = s.level.objects.find((o) => o.name === 'Stage Entity');
  check(!!stage && stage.decorationIds.length === 0, 'fixture has a plain "Stage Entity" without decorations');
  const plan = s.planGiaExport([stage.id]);
  check(plan.objects.length === 1 && plan.decorations === 0 && plan.prefabs === 0, 'decoration-less plain object is exportable');
  const out = s.buildGiaExport(plan, { name: 'Stage', timestamp: 1 });
  const gia = new GiaSession(out);
  check(gia.models.length === 1 && gia.models[0].count === 0 && gia.models[0].name === 'Stage Entity', 'GiaSession loads a decoration-less export');
  const g = giaParts(out);
  check(g.top.filter((f) => f.num === 2).length === 0 && shape(g.top[0].raw).join() === '1,3,5,12', 'no decoration entries, no references');

  let threw = null;
  try {
    s.buildGiaExport(s.planGiaExport([]), { name: 'x' });
  } catch (e) {
    threw = e;
  }
  check(threw && threw.i18n && threw.i18n.key === 'gil.export.none', 'building an empty plan throws a localized error');
  check(s.planGiaExport([99]).objects.length === 0 && s.planGiaExport([99]).skipped.length === 0, 'unknown ids are ignored');
}

// --------------------------- 5. graphs, missing graphs, missing prefabs, stale ids
console.log('== export: node graphs, missing pieces, stale decoration ids');
{
  // patch the fixture: bind the parent to the level's "Example Graph" and give
  // it a decoration id that does not exist; bind "Stage Entity" to a graph
  // that does not exist; point "Default Template" at a prefab that does not
  // exist
  const bytes = load('Level With 1 Decoration.gil');
  const container = parseGilContainer(bytes);
  const level = parseLevel(container);
  const cont = level.objectContainerField;
  const fields = parseMessage(cont.raw);
  const BOGUS_DECO = 0x40000fff;
  const BOGUS_GRAPH = 0x40000ffe;
  const BOGUS_PREFAB = 0x40c0ffff;
  const stageId = level.objects.find((o) => o.name === 'Stage Entity').id;
  const bindTo = (ef, guid) => {
    for (let j = 0; j < ef.length; j++) {
      const cf = ef[j];
      if (cf.num !== 6 || cf.wire !== 2) continue;
      const c = readComponent(cf, COMP_B_PAYLOAD);
      if (c.type !== 3) continue;
      const bind = bytesField(c.payloadFieldNum, encodeMessage([msgField(1, [msgField(1, [varintField(1, 1), varintField(2, guid), varintField(501, 20000)])])]));
      ef[j] = msgField(6, c.fields.map((x) => (x === c.payload ? bind : x)));
    }
  };
  const parentPatched = patchObject(fields, PARENT, (ef) => {
    bindTo(ef, EXAMPLE_GRAPH);
    for (let j = 0; j < ef.length; j++) {
      const cf = ef[j];
      if (cf.num !== 5 || cf.wire !== 2) continue;
      const c = readComponent(cf, COMP_A_PAYLOAD);
      if (c.type !== 40) continue;
      const ids = [...level.objectById(PARENT).decorationIds, BOGUS_DECO];
      const np = parseMessage(c.payload.raw).map((pf) => (pf.num === 501 ? bytesField(501, encodePackedVarints(ids)) : pf));
      ef[j] = msgField(5, c.fields.map((x) => (x === c.payload ? bytesField(c.payloadFieldNum, encodeMessage(np)) : x)));
    }
  });
  const stagePatched = patchObject(fields, stageId, (ef) => bindTo(ef, BOGUS_GRAPH));
  patchObject(fields, TEMPLATE_OBJ, (ef) => {
    const i = ef.findIndex((f) => f.num === 2 && f.wire === 2);
    ef[i] = msgField(2, [varintField(1, BOGUS_PREFAB)]);
  });
  cont.raw = encodeMessage(fields);
  const patched = buildGilContainer(container.head, level.encodePayload(), container.suffix);

  const s = new GilSession(patched);
  const idx = s._exportIndex();
  check(idx.graphs.has(EXAMPLE_GRAPH) && idx.graphs.get(EXAMPLE_GRAPH).name === 'Example Graph', 'fixture: the level holds "Example Graph"');
  const plan = s.planGiaExport([PARENT, TEMPLATE_OBJ, stageId]);
  const levelOrder = s.level.objects.filter((o) => o.id === PARENT || o.id === stageId).map((o) => o.id);
  check(same(plan.objects.map((x) => x.id), levelOrder), 'plan exports the parent and Stage Entity, in level order');
  check(plan.skipped.length === 1 && plan.skipped[0].id === TEMPLATE_OBJ && plan.skipped[0].reason === 'prefabMissing', 'object placed from a missing prefab is skipped (prefabMissing)');
  const codes = plan.warnings.map((w) => `${w.code}:${w.params.id}`).sort();
  check(same(codes, [`decoMissing:${PARENT}`, `graphMissing:${stageId}`]), `warnings: stale id on the parent, missing graph on Stage Entity (${codes.join(', ')})`);
  check(plan.warnings.find((w) => w.code === 'decoMissing').params.n === 1, 'missing-decoration warning counts 1');
  check(plan.graphs === 1 && plan.decorations === 3, 'plan carries one graph and the 3 real decorations');

  const out = s.buildGiaExport(plan, { name: 'Patched', timestamp: 1 });
  const g = giaParts(out);
  const entityById = (id) => g.top.find((f) => f.num === 1 && varints(getField(parseMessage(f.raw), 1).raw)[4] === id);
  // parent: 3 decoration refs then the graph ref; binding kept, id list trimmed
  const obj = parseMessage(entityById(PARENT).raw);
  const refs = refsOf(obj).map(refStr);
  check(refs.length === 4 && refs.slice(0, 3).every((r) => r.startsWith('1/14:')) && refs[3] === `5/-:${EXAMPLE_GRAPH}`, 'parent refs: 3 decorations, then the graph {2:5 4:guid}');
  const body = getField(parseMessage(getField(obj, 12).raw), 1).raw;
  const diffs = bodyDiff(parentPatched, body);
  const listFixed = diffs.length === 1 && diffs[0].b.num === 5 && compType(diffs[0].b, COMP_A_PAYLOAD) === 40
    && same(decodePackedVarints(getField(parseMessage(readComponent(diffs[0].b, COMP_A_PAYLOAD).payload.raw), 501).raw), plan.objects.find((x) => x.id === PARENT).item.decoIds);
  check(listFixed, `parent body: only the decoration list changed, binding kept (${diffs.length} field(s) differ)`);
  // the graph entry
  const graphs = g.top.filter((f) => f.num === 2 && fieldVarint(getField(parseMessage(f.raw), 5)) === 9);
  check(graphs.length === 1, 'exactly one class-9 graph entry');
  const ge = parseMessage(graphs[0].raw);
  const gid = varints(getField(ge, 1).raw);
  check(gid[2] === 5 && gid[4] === EXAMPLE_GRAPH && gid[3] === undefined, 'graph identity {2:5 4:guid}');
  check(fieldString(getField(ge, 3)) === 'Example Graph' && same(shape(graphs[0].raw), [1, 3, 5, 13]), 'graph entry: name, class 9, wrapper 13');
  const w13 = parseMessage(getField(ge, 13).raw);
  check(w13.length === 1 && w13[0].num === 1 && same(w13[0].raw, idx.graphs.get(EXAMPLE_GRAPH).raw), 'graph body is the level’s graph entry, verbatim');
  // stage entity: binding emptied, nothing else touched
  const stage = parseMessage(entityById(stageId).raw);
  check(refsOf(stage).length === 0, 'Stage Entity: no graph reference');
  const sdiffs = bodyDiff(stagePatched, getField(parseMessage(getField(stage, 12).raw), 1).raw);
  check(sdiffs.length === 1 && sdiffs[0].b.num === 6 && compType(sdiffs[0].b, COMP_B_PAYLOAD) === 3 && readComponent(sdiffs[0].b, COMP_B_PAYLOAD).payload.raw.length === 0, 'Stage Entity body: only the binding changed, and it is empty');
  const gia = new GiaSession(out);
  const pm = gia.models.find((m) => m.guid === PARENT);
  const sm = gia.models.find((m) => m.guid === stageId);
  check(gia.models.length === 2 && pm.count === 3 && pm.hasGraph && sm.count === 0 && !sm.hasGraph, 'GiaSession: parent has 3 decorations and a graph, Stage Entity has neither');
  check(same(gia.serialize(), out), 'GiaSession: untouched re-serialize is byte-identical');
}

// ----------------------------------------------------- 6. prefab groups
const GROUP_FILE = join(REF, 'Prefab Group.gil');
const FURINA_FILE = join(REF, 'Furina Prefab Group.gia');
if (existsSync(GROUP_FILE)) {
  console.log('== export: prefab groups');
  const s = new GilSession(new Uint8Array(readFileSync(GROUP_FILE)));
  const GROUP = 0x40400001;
  const members = s.groupMembers(GROUP).map((m) => m.id);
  const plan = s.planGiaExport([GROUP]);
  check(plan.objects.length === 1 && plan.skipped.length === 0 && plan.warnings.length === 0, 'plan: the group alone, nothing skipped, no warnings');
  check(plan.prefabs === 14 && plan.members === 8 && plan.graphs === 1 && plan.decorations === 460 && plan.items.length === 483, `plan counts: 14 prefabs, 8 members, 1 graph, 460 decorations (${plan.prefabs}/${plan.members}/${plan.graphs}/${plan.decorations})`);
  const out = s.buildGiaExport(plan, { name: 'Furina_Prefab_Group', timestamp: 1790704016 });
  if (existsSync(FURINA_FILE)) {
    const ref = new Uint8Array(readFileSync(FURINA_FILE));
    check(same(out, ref), `export is byte-identical to the game’s own export (${out.length} bytes)`);
  } else {
    console.log('  (Furina Prefab Group.gia not present, byte comparison skipped)');
  }
  const folded = s.buildGiaExport(s.planGiaExport([GROUP, ...members]), { name: 'Furina_Prefab_Group', timestamp: 1790704016 });
  check(same(folded, out), 'ticking the members as well changes nothing (folded into the group)');
  const gia = new GiaSession(out);
  check(gia.models.length === 1 && gia.models[0].isGroup && gia.models[0].memberCount === 8, 'GiaSession: one model, a group with 8 members');
  check(same(gia.groupMembers(0).map((m) => m.guid), members), 'GiaSession: members in child-list order');
  check(same(gia.groupMembers(0).map((m) => m.count), members.map((id) => s.level.objectById(id).decorationIds.length)), 'GiaSession: member decoration counts match the level');
  check(same(gia.serialize(), out), 'GiaSession: untouched re-serialize is byte-identical');

  // a member ticked without its group goes in on its own
  const MEMBER = 1077936131; // "Body_Spawner": 50 decorations, prefab with 50 more and a graph
  const mo = s.level.objectById(MEMBER);
  const mplan = s.planGiaExport([MEMBER]);
  check(mplan.objects.length === 1 && mplan.warnings.length === 1 && mplan.warnings[0].code === 'memberStandalone', 'lone member: exported with a memberStandalone warning');
  check(mplan.prefabs === 1 && mplan.graphs === 1 && mplan.decorations === 100 && mplan.members === 0, `lone member: its prefab, the graph and 100 decorations (${mplan.prefabs}/${mplan.graphs}/${mplan.decorations})`);
  const mout = s.buildGiaExport(mplan, { name: 'Body_Spawner', timestamp: 1 });
  const mg = giaParts(mout);
  const ment = parseMessage(mg.top[0].raw);
  const mrefs = refsOf(ment).map(refStr);
  check(mrefs.length === 52 && mrefs[0] === '1/1:1077936132' && mrefs.slice(1, 51).every((r) => r.startsWith('1/14:')) && mrefs[51] === `5/-:${EXAMPLE_GRAPH}`, 'lone member refs: prefab, 50 decorations, graph (no membership refs)');
  const mdiffs = bodyDiff(mo.field.raw, getField(parseMessage(getField(ment, 12).raw), 1).raw);
  check(mdiffs.length === 1 && mdiffs[0].b.num === 5 && compType(mdiffs[0].b, COMP_A_PAYLOAD) === 62 && readComponent(mdiffs[0].b, COMP_A_PAYLOAD).payload.raw.length === 0, 'lone member body: only the membership component changed, and it is empty');
  const kinds = mg.top.filter((f) => f.num === 2).map((f) => fieldVarint(getField(parseMessage(f.raw), 5)));
  check(kinds[0] === 1 && kinds.slice(1, 51).every((k) => k === 28) && kinds[51] === 9 && kinds.slice(52).every((k) => k === 28) && kinds.length === 102, 'lone member file order: prefab, its 50 decorations, graph, the entity’s 50 decorations');
  const mgia = new GiaSession(mout);
  check(mgia.models.length === 1 && mgia.models[0].count === 50 && mgia.models[0].hasGraph && !mgia.models[0].isGroup, 'GiaSession: lone member is a plain model with 50 decorations and a graph');
} else {
  console.log('== export: prefab groups (Prefab Group.gil not present, skipped)');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall tests passed');
process.exit(failures ? 1 : 0);
