// Verification suite for js/gia-splitter.js. Run with: node tools/test-splitter.mjs
// Uses the sample fixtures in reference/reference-samples/ and the legacy
// geometry-aware parser (tools/gia-parser.js) as an independent cross-check.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GiaSession, _internal } from '../js/gia-splitter.js';
import { parseGia } from './gia-parser.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLES = join(root, 'reference', 'reference-samples');
const load = (f) => new Uint8Array(readFileSync(join(SAMPLES, f)));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
};
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const files = [
  'White Square.gia',
  'White Square No Collision.gia',
  '2 White Triangles.gia',
  'Asset Pack With Three Triangles.gia',
  'Autumn Sword Auto Assemble.gia',
];

// helpers to inspect raw entries of a file
const rawView = (b) => {
  const payloadLen = new DataView(b.buffer, b.byteOffset).getUint32(16, false);
  const payload = b.subarray(20, 20 + payloadLen);
  const graphs = [], strings = [], decs = new Map();
  for (const it of _internal.parseMsg(payload)) {
    if (it.field === 2 && it.wire === 2) {
      let cls = 0, guid = 0;
      for (const e of _internal.parseMsg(it.val)) {
        if (e.field === 5 && e.wire === 0) cls = Number(e.val);
        if (e.field === 1 && e.wire === 2) {
          for (const f of _internal.parseMsg(e.val)) if (f.field === 4 && f.wire === 0) guid = Number(f.val);
        }
      }
      if (cls === 28) decs.set(guid, it.val);
      else if (cls === 9) graphs.push(it.val);
    } else if ((it.field === 3 || it.field === 5) && it.wire === 2) strings.push(it.val);
  }
  return { graphs, strings, decs };
};

// 1) protobuf re-encode must be lossless on every sample payload
for (const f of files) {
  const bytes = load(f);
  const payloadLen = new DataView(bytes.buffer).getUint32(16, false);
  const payload = bytes.subarray(20, 20 + payloadLen);
  const re = _internal.encodeMsg(_internal.parseMsg(payload));
  check(`re-encode lossless: ${f}`, eq(re, payload), `${payload.length} bytes`);
}

// 2) session with no splits serializes byte-identically
for (const f of files) {
  const bytes = load(f);
  const s = new GiaSession(bytes);
  check(`no-op serialize is byte-identical: ${f}`, eq(s.serialize(), bytes) && !s.changed);
}

// 3) session views: models + decoration identifiers
{
  const s = new GiaSession(load('Asset Pack With Three Triangles.gia'));
  check('asset pack: 3 models listed', s.models.length === 3,
    s.models.map((m) => `${m.name}:${m.count}`).join(', '));
  const decs = s.decorations(0);
  check('asset pack: decoration rows have index + id + name',
    decs.length === 1 && decs[0].index === 0 && decs[0].guid != null && decs[0].name === 'Decoration_1',
    JSON.stringify(decs[0]));
}

// 4) interactive split on the sword: scattered selection from model 0
{
  const bytes = load('Autumn Sword Auto Assemble.gia');
  const src = parseGia(bytes);
  const s = new GiaSession(bytes);

  const model0Before = s.decorations(0).map((d) => d.guid);
  const pick = [0, 5, 6, 7, 500, 998]; // scattered, includes first and last
  const newId = s.splitModel(0, [...pick].reverse()); // order of input must not matter

  check('sword: new model created after source', newId === 1 && s.models.length === 4
    && s.models[1].isNew && s.models[1].count === pick.length,
    s.models.map((m) => `${m.name}:${m.count}${m.isNew ? '*' : ''}`).join(', '));
  check('sword: new model named with suffix', s.models[1].name === 'autumn_sword_3_2');
  check('sword: source model count reduced', s.models[0].count === 999 - pick.length);

  // ordering preserved on both sides
  const movedExpect = pick.map((i) => model0Before[i]);
  const remainExpect = model0Before.filter((_, i) => !pick.includes(i));
  check('sword: moved entries keep source order', eq(s.decorations(1).map((d) => d.guid), movedExpect));
  check('sword: remaining entries keep source order', eq(s.decorations(0).map((d) => d.guid), remainExpect));

  // serialize and cross-check with the independent parser
  const out = s.serialize();
  const dst = parseGia(out);
  check('sword: output has 4 objects', dst.objects.length === 4);
  check('sword: output decoration entry count preserved', dst.decorations.length === src.decorations.length);

  const outM0 = dst.objects.find((o) => o.name === 'autumn_sword_3');
  const outNew = dst.objects.find((o) => o.name === 'autumn_sword_3_2');
  check('sword: reparsed lists match session lists',
    eq(outM0.decorationGuids, remainExpect) && eq(outNew.decorationGuids, movedExpect));
  check('sword: new model guid unique',
    new Set(dst.objects.map((o) => o.guid)).size === dst.objects.length);

  let parentOk = true;
  for (const o of dst.objects) {
    for (const g of o.decorationGuids) {
      const d = dst.decorations.find((d) => d.guid === g);
      if (!d || d.parentGuid !== o.guid) parentOk = false;
    }
  }
  check('sword: parent references match owning model', parentOk);

  // non-Decoration data outside the models preserved byte-exactly
  const a = rawView(bytes), b = rawView(out);
  check('sword: node-graph entries byte-identical',
    a.graphs.length === b.graphs.length && a.graphs.every((g, i) => eq(g, b.graphs[i])));
  check('sword: export tag + engine version byte-identical',
    a.strings.length === b.strings.length && a.strings.every((x, i) => eq(x, b.strings[i])));

  let untouchedOk = true, movedDiffer = 0;
  const movedSet = new Set(movedExpect);
  for (const [g, raw] of a.decs) {
    const outRaw = b.decs.get(g);
    if (!outRaw) { untouchedOk = false; continue; }
    if (movedSet.has(g)) { if (!eq(raw, outRaw)) movedDiffer++; }
    else if (!eq(raw, outRaw)) untouchedOk = false;
  }
  check('sword: unmoved decoration entries byte-identical', untouchedOk);
  check('sword: moved decoration entries differ only where expected',
    movedDiffer === movedSet.size, `${movedDiffer}/${movedSet.size} rewritten`);

  // untouched models emitted verbatim: their names + counts survive
  check('sword: untouched models unchanged',
    dst.objects.some((o) => o.name === 'autumn_sword_2' && o.decorationGuids.length === 543)
    && dst.objects.some((o) => o.name === 'autumn_sword_1' && o.decorationGuids.length === 999));
}

// 5) multiple splits, including splitting a newly created model
{
  const s = new GiaSession(load('Autumn Sword Auto Assemble.gia'));
  const first = s.decorations(0).map((d) => d.guid);

  s.splitModel(0, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);   // model 1: 10 entries
  const secondNew = s.splitModel(1, [0, 2, 4]);      // split the new model again
  s.splitModel(4, [10, 11]);                          // split autumn_sword_2 (now id 4? check below)

  const names = s.models.map((m) => `${m.name}:${m.count}${m.isNew ? '*' : ''}`);
  check('multi: three splits produce six models', s.models.length === 6 && s.splitCount === 3, names.join(', '));
  check('multi: split of a new model is named from it', s.models[secondNew].name === 'autumn_sword_3_2_2',
    s.models[secondNew].name);

  const out = s.serialize();
  const dst = parseGia(out);
  check('multi: reparsed output has 6 objects and all entries', dst.objects.length === 6
    && dst.decorations.length === 2541);

  // full-coverage ordering check: every model's reparsed list matches the session
  let allMatch = true;
  for (const m of s.models) {
    const o = dst.objects.find((o) => o.name === m.name);
    if (!o || !eq(o.decorationGuids, s.decorations(m.id).map((d) => d.guid))) allMatch = false;
  }
  check('multi: every reparsed model list matches session state', allMatch);

  // global conservation: all original guids still present exactly once
  const all = dst.objects.flatMap((o) => o.decorationGuids).sort((x, y) => x - y);
  check('multi: no entries lost or duplicated', eq(all, [...first,
    ...parseGia(load('Autumn Sword Auto Assemble.gia')).objects
      .filter((o) => o.name !== 'autumn_sword_3').flatMap((o) => o.decorationGuids),
  ].sort((x, y) => x - y)));

  // idempotence: reload output, no changes → byte-identical
  const s2 = new GiaSession(out);
  check('multi: reloaded output round-trips byte-identically', eq(s2.serialize(), out));
}

// 6) edge cases
{
  const s = new GiaSession(load('2 White Triangles.gia'));
  let threw = false;
  try { s.splitModel(0, []); } catch { threw = true; }
  check('edge: empty selection rejected', threw && !s.changed);

  s.splitModel(0, [0, 1]); // move ALL entries
  check('edge: moving all entries leaves empty source model',
    s.models[0].count === 0 && s.models[1].count === 2);
  const dst = parseGia(s.serialize());
  check('edge: output parses with empty + full model', dst.objects.length === 2
    && dst.decorations.length === 2);
}

// 7) selective model export
{
  const bytes = load('Autumn Sword Auto Assemble.gia');
  const s = new GiaSession(bytes);

  // selecting every model without splits is still byte-identical
  const allUids = s.models.map((m) => m.uid);
  check('select: full selection without splits is byte-identical', eq(s.serialize(allUids), bytes));

  // empty selection rejected
  let threw = false;
  try { s.serialize([]); } catch { threw = true; }
  check('select: empty selection rejected', threw);

  // exclude one untouched model (no splits at all)
  const dropUid = s.models[1].uid; // autumn_sword_2 (owns no graph)
  const keepUids = allUids.filter((u) => u !== dropUid);
  const out = s.serialize(keepUids);
  const dst = parseGia(out);
  check('select: excluded model omitted', dst.objects.length === 2
    && !dst.objects.some((o) => o.name === 'autumn_sword_2'),
    dst.objects.map((o) => `${o.name}:${o.decorationGuids.length}`).join(', '));
  check('select: excluded model\'s decorations omitted',
    dst.decorations.length === 2541 - 543);

  // kept entries byte-identical, graph + strings intact
  const a = rawView(bytes), b = rawView(out);
  check('select: node-graph entries preserved',
    a.graphs.length === b.graphs.length && a.graphs.every((g, i) => eq(g, b.graphs[i])));
  check('select: export tag + engine version preserved',
    a.strings.length === b.strings.length && a.strings.every((x, i) => eq(x, b.strings[i])));
  let keptIdentical = true;
  for (const [g, raw] of b.decs) {
    const srcRaw = a.decs.get(g);
    if (!srcRaw || !eq(raw, srcRaw)) keptIdentical = false;
  }
  check('select: kept decoration entries byte-identical', keptIdentical);

  // non-decoration entries are always preserved, even when the only model
  // referencing them is excluded from the export
  const graphOwner = s.models.find((m) => m.hasGraph);
  check('select: graph-owning model detected', !!graphOwner, graphOwner?.name);
  const noOwner = s.serialize(allUids.filter((u) => u !== graphOwner.uid));
  const gA = rawView(bytes).graphs, gB = rawView(noOwner).graphs;
  check('select: graph preserved byte-identically even without its owner',
    gB.length === gA.length && gA.every((g, i) => eq(g, gB[i])));

  // split + selection: export only the new model
  const s2 = new GiaSession(bytes);
  const src0 = s2.decorations(0).map((d) => d.guid);
  s2.splitModel(0, [1, 3, 5]);
  const newUid = s2.models[1].uid;
  const onlyNew = parseGia(s2.serialize([newUid]));
  check('select: exporting only the new model works', onlyNew.objects.length === 1
    && onlyNew.objects[0].name === 'autumn_sword_3_2'
    && eq(onlyNew.objects[0].decorationGuids, [src0[1], src0[3], src0[5]])
    && onlyNew.decorations.length === 3);
  check('select: new-model decorations reparented in selective export',
    onlyNew.decorations.every((d) => d.parentGuid === onlyNew.objects[0].guid));

  // partial selection after split: original + untouched models, without the new one
  const withoutNew = parseGia(s2.serialize(s2.models.filter((m) => m.uid !== newUid).map((m) => m.uid)));
  check('select: original keeps remaining entries when new model excluded',
    withoutNew.objects.length === 3
    && withoutNew.objects.find((o) => o.name === 'autumn_sword_3').decorationGuids.length === 996
    && withoutNew.decorations.length === 2541 - 3);
}

// 8) reordering decorations
{
  const bytes = load('Autumn Sword Auto Assemble.gia');
  const s = new GiaSession(bytes);
  const before = s.decorations(0).map((d) => d.guid);

  // move two scattered entries to the front
  const res = s.moveDecorations(0, [10, 5], 0); // input order must not matter
  const expect = [before[5], before[10], ...before.filter((_, i) => i !== 5 && i !== 10)];
  check('reorder: block moved to front', res.changed && res.start === 0 && res.count === 2);
  check('reorder: list order matches expectation', eq(s.decorations(0).map((d) => d.guid), expect));
  check('reorder: session changed without any split', s.changed && s.splitCount === 0 && s.reorderCount === 1);

  const out = s.serialize();
  const dst = parseGia(out);
  check('reorder: reparsed model list has the new order',
    eq(dst.objects.find((o) => o.name === 'autumn_sword_3').decorationGuids, expect));
  check('reorder: same-length file (only list order changed)', out.length === bytes.length);

  // every decoration entry stays byte-identical; metadata attached by guid
  const a = rawView(bytes), b = rawView(out);
  let identical = a.decs.size === b.decs.size;
  for (const [g, raw] of a.decs) { const o = b.decs.get(g); if (!o || !eq(raw, o)) identical = false; }
  check('reorder: every decoration entry byte-identical', identical);
  check('reorder: graphs + strings byte-identical',
    a.graphs.every((g, i) => eq(g, b.graphs[i])) && a.strings.every((x, i) => eq(x, b.strings[i])));

  // no-op move: same position → session stays pristine
  const s2 = new GiaSession(bytes);
  const r2 = s2.moveDecorations(0, [3], 3);
  check('reorder: no-op move does not mark changed', r2.changed === false && !s2.changed && eq(s2.serialize(), bytes));

  // move to the very end
  const s3 = new GiaSession(bytes);
  const first = s3.decorations(0).map((d) => d.guid);
  s3.moveDecorations(0, [0], 9999); // target clamped to list end
  check('reorder: move to end clamps and works',
    eq(s3.decorations(0).map((d) => d.guid), [...first.slice(1), first[0]]));

  // reorder + split compose: split picks from the CURRENT order
  s.splitModel(0, [0, 1]); // the two entries we moved to the front
  check('reorder+split: split respects current order',
    eq(s.decorations(1).map((d) => d.guid), [before[5], before[10]]));
  const dst2 = parseGia(s.serialize());
  check('reorder+split: output parses with both effects', dst2.objects.length === 4
    && eq(dst2.objects.find((o) => o.name === 'autumn_sword_3_2').decorationGuids, [before[5], before[10]]));
}

// 9) Empty Model base + object→decoration conversion
{
  const emptyRef = load('Empty Model.gia');
  const asDec = load('Stone Elemental Cube As Decoration.gia');
  const asObj = load('Stone Elemental Cube As Main Object Model.gia');

  // the new reference files must round-trip like every other sample
  for (const [n, b] of [['Empty Model', emptyRef], ['As Decoration', asDec], ['As Object', asObj]]) {
    const s = new GiaSession(b);
    check(`ref: ${n} no-op byte-identical`, eq(s.serialize(), b));
  }

  // class-3 layout understood: the Empty Model in "As Decoration" owns 1 entry
  {
    const s = new GiaSession(asDec);
    check('ref: class-3 model list parsed', s.models.length === 1
      && s.models[0].name === 'Empty Model' && s.models[0].count === 1);
  }

}

// 10) renaming + moving decorations between models
{
  const bytes = load('Autumn Sword Auto Assemble.gia');

  // rename a model
  {
    const s = new GiaSession(bytes);
    check('rename: model rename returns true and marks changed',
      s.renameModel(0, 'Blade Upper') === true && s.changed && s.renameCount === 1);
    check('rename: same-name rename is a no-op', s.renameModel(0, 'Blade Upper') === false);
    const dst = parseGia(s.serialize());
    check('rename: exported model carries the new name',
      dst.objects.some((o) => o.name === 'Blade Upper' && o.decorationGuids.length === 999)
      && !dst.objects.some((o) => o.name === 'autumn_sword_3'));
    // untouched models stay verbatim
    const a = rawView(bytes), b = rawView(s.serialize());
    let untouched = true;
    for (const [g, raw] of a.decs) if (!eq(raw, b.decs.get(g))) untouched = false;
    check('rename: every decoration entry byte-identical', untouched);
  }

  // rename a decoration
  {
    const s = new GiaSession(bytes);
    const guid = s.decorations(0)[0].guid;
    check('rename: decoration rename reflected in the view',
      s.renameDecoration(0, 0, 'Pommel') === true && s.decorations(0)[0].name === 'Pommel');
    const out = s.serialize();
    const dst = parseGia(out);
    check('rename: exported decoration carries the new name',
      dst.decorations.find((d) => d.guid === guid)?.name === 'Pommel');
    const a = rawView(bytes), b = rawView(out);
    let othersOk = true;
    for (const [g, raw] of a.decs) {
      if (g === guid) { if (eq(raw, b.decs.get(g))) othersOk = false; }
      else if (!eq(raw, b.decs.get(g))) othersOk = false;
    }
    check('rename: only the renamed entry differs', othersOk);
  }

  // move decorations between models
  {
    const s = new GiaSession(bytes);
    const srcList = s.decorations(0).map((d) => d.guid);
    const dstList = s.decorations(1).map((d) => d.guid);
    const moving = [srcList[0], srcList[5]];
    const res = s.moveDecorationsToModel(0, [5, 0], 1); // input order must not matter
    check('move: counts updated', res.count === 2
      && s.models[0].count === 997 && s.models[1].count === 545 && s.moveCount === 1);
    check('move: appended to the target in order',
      eq(s.decorations(1).map((d) => d.guid), [...dstList, ...moving]));
    check('move: same-model move rejected as no-op', s.moveDecorationsToModel(0, [0], 0) === null);

    const out = s.serialize();
    const dst = parseGia(out);
    const m0 = dst.objects.find((o) => o.name === 'autumn_sword_3');
    const m1 = dst.objects.find((o) => o.name === 'autumn_sword_2');
    check('move: reparsed lists match session state',
      eq(m0.decorationGuids, s.decorations(0).map((d) => d.guid))
      && eq(m1.decorationGuids, [...dstList, ...moving]));
    let parentOk = true;
    for (const g of moving) {
      const d = dst.decorations.find((d) => d.guid === g);
      if (!d || d.parentGuid !== m1.guid) parentOk = false;
    }
    check('move: moved entries reparented to the target model', parentOk);
    const a = rawView(bytes), b = rawView(out);
    let movedDiffer = true, unmovedSame = true;
    for (const [g, raw] of a.decs) {
      if (moving.includes(g)) { if (eq(raw, b.decs.get(g))) movedDiffer = false; }
      else if (!eq(raw, b.decs.get(g))) unmovedSame = false;
    }
    check('move: moved entries differ only where expected', movedDiffer && unmovedSame);
    check('move: reloaded output round-trips byte-identically',
      eq(new GiaSession(out).serialize(), out));
  }

  // moves that would exceed the 999-per-model limit are rejected untouched
  {
    const s = new GiaSession(bytes);
    // autumn_sword_2 holds 543; moving 500 more would make 1043 > 999
    const srcBefore = s.decorations(0).map((d) => d.guid);
    const dstBefore = s.decorations(1).map((d) => d.guid);
    let err = null;
    try {
      s.moveDecorationsToModel(0, Array.from({ length: 500 }, (_, i) => i), 1);
    } catch (e) { err = e; }
    check('move limit: over-limit move rejected with err.moveLimit',
      err?.i18n?.key === 'err.moveLimit'
      && err.i18n.params.max === 999 && err.i18n.params.total === 1043
      && err.i18n.params.name === 'autumn_sword_2');
    check('move limit: both models unchanged after rejection',
      eq(s.decorations(0).map((d) => d.guid), srcBefore)
      && eq(s.decorations(1).map((d) => d.guid), dstBefore)
      && s.moveCount === 0 && !s.changed
      && eq(s.serialize(), bytes));
    // landing exactly on the limit is allowed: 543 + 456 = 999
    const res = s.moveDecorationsToModel(0, Array.from({ length: 456 }, (_, i) => i), 1);
    check('move limit: filling to exactly 999 is allowed',
      res.count === 456 && s.models[1].count === 999 && s.models[0].count === 543);
  }
}

// 11) 3D viewer point data + bulk rename with undo/redo
{
  // world positions: the legacy parser bakes positions as dec + modelPos*10
  // (in 0.1 m units); the engine's points are meters, so point = baked / 10
  // whenever zoom is the default 0.1. Cross-check on a model with a
  // non-zero world position (White Square: model at ~(3.73, 0, -2.70))
  {
    const bytes = load('White Square.gia');
    const s = new GiaSession(bytes);
    const pts = s.decorationPoints(0);
    const legacy = parseGia(bytes);
    const close = (a, b) => Math.abs(a - b) < 1e-4;
    check('viewer: one point per decoration', pts.length === 1 && pts[0].index === 0
      && pts[0].guid === legacy.decorations[0].guid && pts[0].name === 'Decoration_1');
    check('viewer: world position matches legacy parser baking',
      close(pts[0].x, legacy.decorations[0].position.x / 10)
      && close(pts[0].y, legacy.decorations[0].position.y / 10)
      && close(pts[0].z, legacy.decorations[0].position.z / 10),
      `(${pts[0].x.toFixed(3)}, ${pts[0].y.toFixed(3)}, ${pts[0].z.toFixed(3)})`);
  }
  {
    const s = new GiaSession(load('Autumn Sword Auto Assemble.gia'));
    const pts = s.decorationPoints(0);
    check('viewer: sword model 0 has 999 finite points',
      pts.length === 999 && pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)));
    // points survive splits: clone inherits the source transform
    s.splitModel(0, [0, 1, 2]);
    const clonePts = s.decorationPoints(1);
    check('viewer: split clone keeps identical world positions',
      clonePts.length === 3
      && clonePts.every((p, i) => p.x === pts[i].x && p.y === pts[i].y && p.z === pts[i].z));
  }

  // bulk rename + undo/redo
  {
    const bytes = load('Autumn Sword Auto Assemble.gia');
    const s = new GiaSession(bytes);
    const op = s.renameDecorationsBulk(0, [0, 1, 2, 5], 'Blade Part');
    check('bulk rename: applied to every selected decoration', op.changes.length === 4
      && [0, 1, 2, 5].every((i) => s.decorations(0)[i].name === 'Blade Part')
      && s.decorations(0)[3].name === 'Decoration_4'
      && s.changed && s.renameCount === 1);
    const renamedOut = s.serialize();
    check('bulk rename: exported names applied',
      parseGia(renamedOut).decorations.filter((d) => d.name === 'Blade Part').length === 4);

    s.revertRename(op);
    check('bulk rename: undo restores names and pristine state',
      s.decorations(0)[0].name === 'Decoration_1' && !s.changed
      && eq(s.serialize(), bytes));

    s.replayRename(op);
    check('bulk rename: redo reapplies identically',
      s.decorations(0)[0].name === 'Blade Part' && eq(s.serialize(), renamedOut));

    // stacking: rename over a rename, then unwind both
    const op2 = s.renameDecorationsBulk(0, [0], 'Pommel');
    check('bulk rename: stacked rename wins', s.decorations(0)[0].name === 'Pommel');
    s.revertRename(op2);
    check('bulk rename: undo of stacked rename restores prior rename',
      s.decorations(0)[0].name === 'Blade Part');
    s.revertRename(op);
    check('bulk rename: full unwind is byte-identical', !s.changed && eq(s.serialize(), bytes));
  }
}

// 9) entity groups: a class-3 group entity (field 1) whose members are
//    class-3 entities in field 2; ungrouping frees them as main objects.
//    The fixture is a user export kept locally (reference/ is gitignored);
//    the section is skipped when it is absent.
{
  const f = 'Furina Prefab Group.gia';
  let bytes = null;
  try { bytes = load(f); } catch { /* fixture not present */ }
  const optional = (name) => { try { return load(name); } catch { return null; } };
  const mainObjects = (b) => {
    const payloadLen = new DataView(b.buffer, b.byteOffset).getUint32(16, false);
    return _internal.parseMsg(b.subarray(20, 20 + payloadLen)).filter((it) => it.field === 1 && it.wire === 2).length;
  };
  if (!bytes) {
    console.log(`SKIP  entity groups: ${f} not present`);
  } else {
    const s = new GiaSession(bytes);
    check('group: detected, with member count and no bogus decorations',
      s.models.length === 1 && s.models[0].isGroup && s.models[0].memberCount === 8 && s.models[0].count === 0,
      JSON.stringify(s.models[0]));
    const members = s.groupMembers(0);
    check('group: member view lists entities in child order with their decoration counts',
      members.length === 8 && members.every((x, i) => x.index === i)
      && members[1].name === 'Body_Spawner' && members[1].count === 50 && members[1].hasGraph
      && members[2].name === 'Head_Furina' && members[2].count === 82 && !members[2].hasGraph,
      members.map((x) => `${x.name}:${x.count}`).join(', '));
    check('group: member points carry world positions',
      s.groupMemberPoints(0).length === 8 && Math.abs(s.groupMemberPoints(0)[1].x - 1.6802940368652344) < 1e-9);
    check('group: no-op serialize is byte-identical', eq(s.serialize(), bytes) && !s.changed);

    const r = s.ungroup(0);
    check('group: ungroup all frees every member and removes the group',
      r.removedGroup && r.count === 8 && r.newIds.join() === '0,1,2,3,4,5,6,7'
      && s.models.length === 8 && s.models.every((m) => !m.isGroup)
      && s.models[2].name === 'Head_Furina' && s.models[2].count === 82 && s.changed && s.ungroupCount === 1);
    const out = s.serialize();
    check('group: output has 8 main objects and every decoration entry byte-identical',
      mainObjects(out) === 8 && (() => {
        const a = rawView(bytes).decs, b = rawView(out).decs;
        return a.size === b.size && [...a].every(([g, v]) => b.has(g) && eq(b.get(g), v));
      })());
    const s2 = new GiaSession(out);
    check('group: output reloads as 8 plain models with all decorations',
      s2.models.length === 8 && s2.models.every((m) => !m.isGroup) && s2.meta.decorationEntries === 460
      && eq(s2.serialize(), out));
    const expFull = optional('Furina Prefab Group Ungrouped.gia');
    if (expFull) check('group: matches the independently verified ungrouped fixture', eq(out, expFull));

    // partial: only name-matched members leave; the group keeps the rest
    const p = new GiaSession(bytes);
    const guids = p.groupMembers(0).filter((x) => /Furina|Body_Spawner/.test(x.name)).map((x) => x.guid);
    const r2 = p.ungroup(0, guids);
    check('group: partial ungroup keeps the group with the remaining members',
      !r2.removedGroup && r2.count === 6 && r2.newIds.join() === '1,2,3,4,5,6'
      && p.models.length === 7 && p.models[0].isGroup && p.models[0].memberCount === 2
      && p.groupMembers(0).map((x) => x.name).join('|') === '体素角色-四肢关节|Prefab Replica_体素达达利亚-本体');
    const partialOut = p.serialize();
    check('group: partial output has group + 6 main objects', mainObjects(partialOut) === 7);
    const expPart = optional('Furina Prefab Group Partially Ungrouped.gia');
    if (expPart) check('group: matches the independently verified partial fixture', eq(partialOut, expPart));
    const r3 = p.ungroup(0);
    check('group: ungrouping the rest removes the group',
      r3.removedGroup && r3.count === 2 && p.models.length === 8 && p.models.every((m) => !m.isGroup)
      && p.models[0].name === '体素角色-四肢关节' && p.models[2].name === 'Body_Spawner');

    // error paths leave the session untouched
    let key = null;
    try { new GiaSession(bytes).ungroup(0, [1]); } catch (e) { key = e.i18n?.key; }
    check('group: unknown member guids → err.selectMember', key === 'err.selectMember');
    key = null;
    try { s.ungroup(0); } catch (e) { key = e.i18n?.key; }
    check('group: ungroup on a plain model → err.notGroup', key === 'err.notGroup');

    // the freed members are ordinary models: split + rename + reload
    const nid = s.splitModel(2, [0, 1]);
    s.renameModel(nid, 'Head_Split');
    const s3 = new GiaSession(s.serialize());
    check('group: split + rename after ungroup survive reload',
      s3.models.length === 9 && s3.models[2].count === 80 && s3.models[3].name === 'Head_Split' && s3.models[3].count === 2
      && s3.meta.decorationEntries === 460);
    // selective export drops an excluded freed member's decorations only
    const s4 = new GiaSession(bytes);
    s4.ungroup(0);
    const sub = new GiaSession(s4.serialize(s4.models.filter((m) => m.name !== 'Head_Furina').map((m) => m.uid)));
    check('group: selective export after ungroup', sub.models.length === 7 && sub.meta.decorationEntries === 460 - 82);
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll tests passed.');
process.exit(failures ? 1 : 0);
