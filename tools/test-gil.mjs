/**
 * Node test harness for the .gil engine (js/gil/). Run:
 *   node tools/test-gil.mjs [reference-dir]
 * Verifies, against the reference .gil files in reference/reference-samples/:
 *   1. byte-for-byte round-trip of untouched files
 *   2. split correctness (world transforms match the game-authored
 *      standalone versions in "Level With No Decorations.gil")
 *   3. parents keep everything except the decoration-id list
 *   4. registry updates, id uniqueness, output re-parses cleanly
 * The 11 MB performance file ("Cozy Disc Golf.gil") is optional; the section
 * is skipped when it is absent from the reference dir.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseGilContainer, buildGilContainer, parseMessage, getField, fieldVarint } from '../js/gil/gil.js';
import { parseLevel, COMP_A_PAYLOAD, readComponent } from '../js/gil/model.js';
import { planSplit, applySplit, composeTransforms, quatFromEuler, eulerFromQuat, MAX_SCALE } from '../js/gil/split.js';

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
function loadLevel(name) {
  const bytes = new Uint8Array(readFileSync(join(REF, name)));
  const container = parseGilContainer(bytes);
  return { bytes, container, level: parseLevel(container) };
}

const FILES = [
  'Level With No Decorations.gil',
  'Level With 1 Decoration.gil',
  'Level With 2 Decorations.gil',
  'Level With 1 Alt Decorations.gil',
];

// ---------------------------------------------------------- 1. round-trip
console.log('== round-trip identity');
for (const name of FILES) {
  const { bytes, container, level } = loadLevel(name);
  const out = buildGilContainer(container.head, level.encodePayload(), container.suffix);
  const same = out.length === bytes.length && out.every((b, i) => b === bytes[i]);
  check(same, `${name}: ${bytes.length} bytes round-trip byte-identical`);
}

// ------------------------------------------------- 2. split "1 Decoration"
console.log('== split: Level With 1 Decoration');
{
  const { level } = loadLevel('Level With 1 Decoration.gil');
  const none = loadLevel('Level With No Decorations.gil').level;

  const parents = level.objects.filter((o) => o.decorationIds.length);
  check(parents.length === 1 && parents[0].id === 1077936136, 'one parent (1077936136) found');
  check(level.decorations.length === 3, '3 decorations found');

  const plan = planSplit(level, parents.map((p) => p.id));
  check(plan.errors.length === 0, 'plan has no errors: ' + JSON.stringify(plan.errors));
  check(plan.entries.length === 3, 'plan extracts 3 decorations');

  const before = level.objects.length;
  const parentRawBefore = parents[0].field.raw;
  const summary = await applySplit(level, plan);
  check(summary.created.length === 3, '3 world objects created');
  check(level.decorations.length === 0, 'decoration list now empty');
  check(level.objects.length === before + 3, 'object count grew by 3');

  // World transforms must match the game-authored standalone objects, matched
  // by prefab id (each prefab appears once in this data set).
  for (const c of summary.created) {
    const mine = level.objectById(c.id);
    const ref = none.objects.find(
      (o) => o.prefabId === c.prefabId && [1077936129, 1077936131, 1077936132].includes(o.id)
    );
    check(!!ref, `reference standalone object exists for prefab ${c.prefabId}`);
    if (!ref) continue;
    const dp = ['x', 'y', 'z'].map((a) => Math.abs(mine.transform.pos[a] - ref.transform.pos[a]));
    check(Math.max(...dp) < 1e-5, `prefab ${c.prefabId}: world position matches reference (${dp.map((d) => d.toExponential(1)).join(', ')})`);
    const ds = ['x', 'y', 'z'].map((a) => Math.abs(mine.transform.scale[a] - ref.transform.scale[a]));
    check(Math.max(...ds) < 1e-6, `prefab ${c.prefabId}: world scale matches reference`);
    const dr = ['x', 'y', 'z'].map((a) => Math.abs(mine.transform.rot[a] - ref.transform.rot[a]));
    check(Math.max(...dr) < 1e-6, `prefab ${c.prefabId}: world rotation matches reference`);
    check(mine.name === 'Decoration_' + { 20001001: 3, 20001052: 2, 20001013: 1 }[c.prefabId], `prefab ${c.prefabId}: name preserved (${mine.name})`);
  }

  // Parent must be byte-identical except for the removed 501 list.
  const parentAfter = level.objectById(1077936136);
  check(parentAfter.decorationIds.length === 0, 'parent decoration list cleared');
  {
    const fa = parseMessage(parentRawBefore);
    const fb = parseMessage(parentAfter.field.raw);
    check(fa.length === fb.length, 'parent field count unchanged');
    let diffs = 0;
    for (let i = 0; i < Math.min(fa.length, fb.length); i++) {
      const a = fa[i], b = fb[i];
      if (a.num !== b.num || a.wire !== b.wire || a.raw.length !== b.raw.length || !a.raw.every((x, j) => x === b.raw[j])) diffs++;
    }
    check(diffs === 1, `exactly one parent field changed (the comp-40 component); got ${diffs}`);
  }

  // Registry: new ids present in the same group as the parent.
  const group = level.registryWorldGroups().find((g) => g.ids.includes(1077936136));
  check(!!group && summary.created.every((c) => group.ids.includes(c.id)), 'registry lists all new object ids');

  // Ids unique across objects.
  const ids = level.objects.map((o) => o.id);
  check(new Set(ids).size === ids.length, 'object ids unique');

  // Serialized output re-parses.
  const out = buildGilContainer(level.container.head, level.encodePayload(), level.container.suffix);
  const re = parseLevel(parseGilContainer(out));
  check(re.objects.length === level.objects.length, 'output re-parses with same object count');
  check(re.decorations.length === 0, 'output re-parses with no decorations');
}

// ------------------------------------------------ 3. split "2 Decorations"
console.log('== split: Level With 2 Decorations');
{
  const { level } = loadLevel('Level With 2 Decorations.gil');
  const one = loadLevel('Level With 1 Decoration.gil').level;

  const parents = level.objects.filter((o) => o.decorationIds.length);
  check(parents.length === 2, 'two parents found');
  check(level.decorations.length === 6, '6 decorations found');

  // Split only the second parent (1077936138); its standalone counterparts
  // live in the 1-Decoration file (Shield x2 + Polearm).
  const plan = planSplit(level, [1077936138]);
  check(plan.errors.length === 0, 'plan has no errors');
  check(plan.entries.length === 3, 'plan extracts 3 of 6 decorations');
  const summary = await applySplit(level, plan);
  check(level.decorations.length === 3, 'other parent’s decorations untouched');
  check(level.objectById(1077936136).decorationIds.length === 3, 'other parent keeps its list');

  const refIds = [1077936133, 1077936134, 1077936135];
  for (const c of summary.created) {
    const mine = level.objectById(c.id);
    const ref = one.objects.find((o) => refIds.includes(o.id) && o.prefabId === c.prefabId);
    check(!!ref, `reference standalone object exists for prefab ${c.prefabId}`);
    if (!ref) continue;
    const dp = ['x', 'y', 'z'].map((a) => Math.abs(mine.transform.pos[a] - ref.transform.pos[a]));
    check(Math.max(...dp) < 1e-5, `prefab ${c.prefabId}: world position matches reference (${dp.map((d) => d.toExponential(1)).join(', ')})`);
  }
}

// --------------------------------------------- 4. split the Alt water body
console.log('== split: Level With 1 Alt Decorations');
{
  const { level } = loadLevel('Level With 1 Alt Decorations.gil');
  const parents = level.objects.filter((o) => o.decorationIds.length);
  check(parents.length === 1 && parents[0].id === 1077936141, 'water-body parent found');
  const plan = planSplit(level, [1077936141]);
  check(plan.errors.length === 0, 'plan has no errors');
  check(plan.entries.length === 2, 'plan extracts 2 decorations');
  check(
    plan.warnings.some((w) => w.code === 'parentRefsDecos'),
    'warns about the water-body component referencing a decoration'
  );
  const parentRawBefore = parents[0].field.raw;
  await applySplit(level, plan);
  const parentAfter = level.objectById(1077936141);
  check(parentAfter.decorationIds.length === 0, 'parent decoration list cleared');
  // All parent components except comp-40 unchanged (including the water-body
  // extras 91/88 and the 3/13 reference).
  {
    const fa = parseMessage(parentRawBefore);
    const fb = parseMessage(parentAfter.field.raw);
    let diffs = 0;
    for (let i = 0; i < Math.min(fa.length, fb.length); i++) {
      const a = fa[i], b = fb[i];
      if (a.num !== b.num || a.wire !== b.wire || a.raw.length !== b.raw.length || !a.raw.every((x, j) => x === b.raw[j])) diffs++;
    }
    check(fa.length === fb.length && diffs === 1, 'only the comp-40 component changed on the water body');
  }
  const out = buildGilContainer(level.container.head, level.encodePayload(), level.container.suffix);
  const re = parseLevel(parseGilContainer(out));
  check(re.decorations.length === 0 && re.objects.length === level.objects.length, 'output re-parses');
}

// ------------------------------------------------- 5. no-deco level: no-op
console.log('== no-decoration level');
{
  const { level } = loadLevel('Level With No Decorations.gil');
  check(level.objects.filter((o) => o.decorationIds.length).length === 0, 'no eligible parents');
  check(level.decorations.length === 0, 'no decorations');
}

// ---------------------------------- 5b. rotate/zoom side-by-side validation
console.log('== split: Level With 1 Decoration Rotate Zoom Example');
{
  const { level } = loadLevel('Level With 1 Decoration Rotate Zoom Example.gil');
  const none = loadLevel('Level With No Decorations Rotate Zoom Example.gil').level;

  const parents = level.objects.filter((o) => o.decorationIds.length);
  check(parents.length === 1 && parents[0].id === 1077936142, 'rotated+scaled parent (1077936142) found');
  const p = parents[0];
  check(
    p.transform.rot.y === 45 && p.transform.scale.x === 0.5 && p.transform.scale.y === 1 && p.transform.scale.z === 0.5,
    'parent has rot y=45, scale (0.5,1,0.5)'
  );
  const deco = level.decorations[0];
  check(deco.transform.rot.y === -45 && deco.transform.scale.x === 2, 'decoration has rot y=-45, scale x=2');

  const plan = planSplit(level, [p.id]);
  check(plan.errors.length === 0, 'plan has no errors');
  const summary = await applySplit(level, plan);
  check(summary.created.length === 1, 'one world object created');

  // The game allocated 1077936143 for this exact operation, and we must match:
  // ids stay in the 0x4040xxxx space, unaffected by the registry's special
  // 0x4140xxxx entry.
  check(summary.created[0].id === 1077936143, `allocated id matches the game's (1077936143), got ${summary.created[0].id}`);

  const mine = level.objectById(summary.created[0].id);
  const ref = none.objectById(1077936143);
  check(!!ref && ref.prefabId === 20001220 && mine.prefabId === 20001220, 'reference standalone object 1077936143 (prefab 20001220) found');

  // Bit-exact float32 comparison against the game's own detach output.
  const f32 = (x) => Math.fround(x);
  for (const axis of ['x', 'y', 'z']) {
    check(
      f32(mine.transform.pos[axis]) === f32(ref.transform.pos[axis]),
      `world position ${axis} bit-exact: ${mine.transform.pos[axis]} vs ${ref.transform.pos[axis]}`
    );
    check(
      f32(mine.transform.scale[axis]) === f32(ref.transform.scale[axis]),
      `world scale ${axis} bit-exact: ${mine.transform.scale[axis]} vs ${ref.transform.scale[axis]}`
    );
    // rotation compared modulo 360 (equivalent representations allowed)
    const d = Math.abs(((mine.transform.rot[axis] - ref.transform.rot[axis]) % 360 + 540) % 360 - 180);
    check(d < 1e-4, `world rotation ${axis} equivalent: ${mine.transform.rot[axis]} vs ${ref.transform.rot[axis]}`);
  }

  // The parent itself must keep its rotation/scale untouched.
  const pAfter = level.objectById(1077936142);
  check(
    pAfter.transform.rot.y === 45 && pAfter.transform.scale.x === 0.5,
    'parent transform untouched after split'
  );

  // Round-trip identity of the new files while we are here.
  for (const name of [
    'Level With 1 Decoration Rotate Zoom Example.gil',
    'Level With No Decorations Rotate Zoom Example.gil',
  ]) {
    const { bytes, container, level: L } = loadLevel(name);
    const out = buildGilContainer(container.head, L.encodePayload(), container.suffix);
    check(out.length === bytes.length && out.every((b, i) => b === bytes[i]), `${name}: round-trip byte-identical`);
  }
}

// ------------------------------------------------------ 5c. collision state
console.log('== collision (component B/5, "PropertyStaticCollider")');
{
  // Round-trip identity of the collision reference file.
  const { bytes, container, level: nocol } = loadLevel(
    'Level With No Decorations Rotate Zoom Example No Collision.gil'
  );
  const out = buildGilContainer(container.head, nocol.encodePayload(), container.suffix);
  check(out.length === bytes.length && out.every((b, i) => b === bytes[i]), 'No Collision file: round-trip byte-identical');

  // The only object-level difference vs the with-collision variant is object
  // 1077936143's B/5 payload: {1:1,2:1} → empty.
  const withcol = loadLevel('Level With No Decorations Rotate Zoom Example.gil').level;
  check(withcol.objectById(1077936143).collision === true, 'reference object has collision enabled in base file');
  check(nocol.objectById(1077936143).collision === false, 'reference object has collision disabled in No Collision file');
  const othersOk = nocol.objects.every((o) => o.id === 1077936143 || o.collision !== false);
  check(othersOk, 'all other objects keep collision enabled/default');

  // Extraction preserves a decoration's collision state. The rotate/zoom
  // decoration has collision enabled ({1:1,2:1}); verify it carries over.
  const { level: rz } = loadLevel('Level With 1 Decoration Rotate Zoom Example.gil');
  check(rz.decorations[0].collision === true, 'decoration collision state readable (enabled)');
  const plan = planSplit(rz, [1077936142]);
  const summary = await applySplit(rz, plan);
  check(rz.objectById(summary.created[0].id).collision === true, 'extracted object keeps collision enabled');

  // Synthetic disabled-collision decoration: same decoration with its B/5
  // payload emptied must produce a world object with empty B/5 (disabled).
  const { level: rz2 } = loadLevel('Level With 1 Decoration Rotate Zoom Example.gil');
  const deco = rz2.decorations[0];
  // Rebuild the decoration's compB with an emptied type-5 payload.
  const { COMP_B_PAYLOAD } = await import('../js/gil/model.js');
  const { encodeMessage, varintField, bytesField } = await import('../js/gil/gil.js');
  const patchedCompB = deco.compB.map((cf) => {
    try {
      const c = readComponent(cf, COMP_B_PAYLOAD);
      if (c.type === 5) {
        return { num: cf.num, wire: 2, raw: encodeMessage([varintField(1, 5), bytesField(15, new Uint8Array(0))]) };
      }
    } catch { /* ignore */ }
    return cf;
  });
  const fakeDeco = { ...deco, compB: patchedCompB, collision: false };
  const { buildWorldObject } = await import('../js/gil/split.js');
  const built = buildWorldObject(fakeDeco, { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, 0x40400099);
  const builtFields = parseMessage(built.raw);
  let builtCollision = null;
  for (const f of builtFields) {
    if (f.num !== 6 || f.wire !== 2) continue;
    const cf2 = parseMessage(f.raw);
    const t = getField(cf2, 1);
    if (t && t.wire === 0 && fieldVarint(t) === 5) {
      const pf = getField(cf2, 15);
      builtCollision = pf ? pf.raw.length !== 0 : null;
    }
  }
  check(builtCollision === false, 'extracted object keeps collision disabled (empty B/5 payload preserved)');
}

// ---------------------------------------- 5d. collision override option
console.log('== collision override (extraction option)');
{
  const splitOnce = async (collision) => {
    const { level } = loadLevel('Level With 1 Decoration Rotate Zoom Example.gil');
    const plan = planSplit(level, [1077936142]);
    const summary = await applySplit(level, plan, collision === undefined ? {} : { collision });
    return { level, id: summary.created[0].id };
  };

  // Override ON: extracted object gets collision even though it already had it.
  {
    const { level, id } = await splitOnce(true);
    check(level.objectById(id).collision === true, 'override on → extracted object collision enabled');
  }
  // Override OFF: same decoration (originally collision-enabled) comes out disabled.
  {
    const { level, id } = await splitOnce(false);
    check(level.objectById(id).collision === false, 'override off → extracted object collision disabled');
  }
  // No option: original state preserved (back-compat).
  {
    const { level, id } = await splitOnce(undefined);
    check(level.objectById(id).collision === true, 'no option → original state preserved');
  }

  // The override must change ONLY the B/5 component: compare the two outputs.
  {
    const a = await splitOnce(true), b = await splitOnce(false);
    const fa = parseMessage(a.level.objectById(a.id).field.raw);
    const fb = parseMessage(b.level.objectById(b.id).field.raw);
    check(fa.length === fb.length, 'override outputs have same field count');
    let diffs = 0;
    let diffIsB5 = false;
    for (let i = 0; i < Math.min(fa.length, fb.length); i++) {
      const x = fa[i], y = fb[i];
      const same = x.num === y.num && x.wire === y.wire && x.raw.length === y.raw.length && x.raw.every((v, j) => v === y.raw[j]);
      if (!same) {
        diffs++;
        if (x.num === 6) {
          try {
            const tf = getField(parseMessage(x.raw), 1);
            if (tf && fieldVarint(tf) === 5) diffIsB5 = true;
          } catch { /* ignore */ }
        }
      }
    }
    check(diffs === 1 && diffIsB5, `override changes exactly the B/5 component (diffs=${diffs})`);
    // Other world objects (e.g. the parent) are untouched by the option:
    const pa = a.level.objectById(1077936142).field.raw;
    const pb = b.level.objectById(1077936142).field.raw;
    check(pa.length === pb.length && pa.every((v, i) => v === pb[i]), 'non-extracted objects identical across override modes');
  }

  // Undo restores the pre-split state including collision (snapshot-based).
  {
    const { bytes, container, level } = loadLevel('Level With 1 Decoration Rotate Zoom Example.gil');
    const before = {
      obj: level.objectContainerField.raw,
      reg: level.registryContainerField.raw,
      deco: level.decoContainerField.raw,
    };
    const plan = planSplit(level, [1077936142]);
    await applySplit(level, plan, { collision: false });
    // simulate app undo: restore container raws
    level.objectContainerField.raw = before.obj;
    level.registryContainerField.raw = before.reg;
    level.decoContainerField.raw = before.deco;
    level.invalidate();
    const out = buildGilContainer(container.head, level.encodePayload(), container.suffix);
    check(out.length === bytes.length && out.every((b, i) => b === bytes[i]), 'undo after collision-off split restores byte-identical file');
  }
}

// ---------------------------------------- 5e. remove-parent option
console.log('== remove parent after extraction');
{
  const { checkParentRemoval, countExternalIdReferences } = await import('../js/gil/split.js');

  // Reference scanner sanity: id 1073741825 is used by terrain/graphs/etc.
  // (a different id space) so it must report references; the parent id must not.
  {
    const { level } = loadLevel('Level With 1 Decoration.gil');
    check(countExternalIdReferences(level, 1073741825) > 0, 'scanner finds references for a heavily-used id');
    // The raw counter now sees the decorations' own 502 back-references…
    check(countExternalIdReferences(level, 1077936136) === 3, 'raw scan counts the 3 decoration back-references');
    // …which the extraction-aware collector excludes (they are removed with the split).
    const { collectExternalIdReferences } = await import('../js/gil/split.js');
    const parent = level.objectById(1077936136);
    const hits = collectExternalIdReferences(level, new Set([1077936136]), new Set(parent.decorationIds));
    check((hits.get(1077936136) || 0) === 0, 'parent has no external references once its decorations are excluded');
    const chk = checkParentRemoval(level, [1077936136]);
    check(chk.removable.has(1077936136) && chk.warnings.length === 0, 'parent is removable, no warnings');
  }

  // Full removal flow on the 1-Decoration file.
  {
    const { bytes, container, level } = loadLevel('Level With 1 Decoration.gil');
    const before = {
      obj: level.objectContainerField.raw,
      reg: level.registryContainerField.raw,
      deco: level.decoContainerField.raw,
    };
    const objCountBefore = level.objects.length;
    const plan = planSplit(level, [1077936136]);
    const chk = checkParentRemoval(level, [1077936136]);
    const summary = await applySplit(level, plan, {
      removeParent: true,
      removableParents: chk.removable,
    });
    check(summary.removedParents === 1, 'summary reports one parent removed');
    check(level.objectById(1077936136) === undefined, 'parent gone from object container');
    check(level.objects.length === objCountBefore + 3 - 1, 'object count = +3 extracted −1 parent');
    check(level.decorations.length === 0, 'decorations extracted');
    const inRegistry = level.registryWorldGroups().some((g) => g.ids.includes(1077936136));
    check(!inRegistry, 'parent registry item removed');
    check(
      summary.created.every((c) => level.registryWorldGroups().some((g) => g.ids.includes(c.id))),
      'new objects registered'
    );
    check(countExternalIdReferences(level, 1077936136) === 0, 'no dangling references to the removed parent');
    // Extracted transforms still match the game-authored reference.
    const none = loadLevel('Level With No Decorations.gil').level;
    for (const c of summary.created) {
      const mine = level.objectById(c.id);
      const ref = none.objects.find(
        (o) => o.prefabId === c.prefabId && [1077936129, 1077936131, 1077936132].includes(o.id)
      );
      const dp = ['x', 'y', 'z'].map((a) => Math.abs(mine.transform.pos[a] - ref.transform.pos[a]));
      check(Math.max(...dp) < 1e-5, `prefab ${c.prefabId}: world position intact after parent removal`);
    }
    // Output re-parses cleanly.
    const out = buildGilContainer(container.head, level.encodePayload(), container.suffix);
    const re = parseLevel(parseGilContainer(out));
    check(re.objects.length === level.objects.length, 'output re-parses');
    // Undo (snapshot restore) → byte-identical original.
    level.objectContainerField.raw = before.obj;
    level.registryContainerField.raw = before.reg;
    level.decoContainerField.raw = before.deco;
    level.invalidate();
    const out2 = buildGilContainer(container.head, level.encodePayload(), container.suffix);
    check(out2.length === bytes.length && out2.every((b, i) => b === bytes[i]), 'undo restores byte-identical file');
  }

  // removeParent respects the removable set: a parent NOT in the set is kept.
  {
    const { level } = loadLevel('Level With 1 Decoration.gil');
    const plan = planSplit(level, [1077936136]);
    await applySplit(level, plan, { removeParent: true, removableParents: new Set() });
    const parent = level.objectById(1077936136);
    check(!!parent, 'unsafe parent kept in the level');
    check(parent.decorationIds.length === 0, 'kept parent still loses its decoration list');
  }

  // Option off: parent kept (regression).
  {
    const { level } = loadLevel('Level With 1 Decoration.gil');
    const plan = planSplit(level, [1077936136]);
    const summary = await applySplit(level, plan, { removeParent: false });
    check(!!level.objectById(1077936136) && summary.removedParents === 0, 'option off keeps the parent');
  }
}

// ---------------------------------------- 5f. partial extraction (selected decorations)
console.log('== partial extraction (onlyDecoIds)');
{
  const { level } = loadLevel('Level With 1 Decoration.gil');
  const parent = level.objectById(1077936136);
  const [keepId, ...takeIds] = parent.decorationIds; // extract 2 of 3
  const plan = planSplit(level, [1077936136], { onlyDecoIds: new Set(takeIds) });
  check(plan.errors.length === 0, 'partial plan has no errors');
  check(plan.entries.length === 2, 'plan extracts exactly the 2 selected decorations');
  const summary = await applySplit(level, plan, { removeParent: true, removableParents: new Set([1077936136]) });
  check(summary.created.length === 2, '2 world objects created');
  check(level.decorations.length === 1, 'unselected decoration remains in the container');
  check(level.decorationById(keepId) !== undefined, 'the kept decoration is the unselected one');
  const parentAfter = level.objectById(1077936136);
  check(!!parentAfter, 'parent NOT removed while decorations remain (despite removeParent)');
  check(
    parentAfter.decorationIds.length === 1 && parentAfter.decorationIds[0] === keepId,
    'parent 501 list rewritten to keep only the unselected decoration'
  );
  // extract the rest → parent empties and may now be removed
  const plan2 = planSplit(level, [1077936136], { onlyDecoIds: new Set([keepId]) });
  const summary2 = await applySplit(level, plan2, { removeParent: true, removableParents: new Set([1077936136]) });
  check(summary2.created.length === 1 && summary2.removedParents === 1, 'second pass empties the parent and removes it');
  check(level.decorations.length === 0 && level.objectById(1077936136) === undefined, 'level clean after both passes');
  const out = buildGilContainer(level.container.head, level.encodePayload(), level.container.suffix);
  const re = parseLevel(parseGilContainer(out));
  check(re.objects.length === level.objects.length, 'output re-parses after partial extractions');
}

// -------------------------------------------------- 6. transform math units
console.log('== transform math');
{
  const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
  const I = { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };

  // Identity parent: local passes through unchanged.
  let r = composeTransforms(I, { pos: { x: 1, y: 2, z: 3 }, rot: { x: 10, y: 20, z: 30 }, scale: { x: 2, y: 2, z: 2 } });
  check(near(r.pos.x, 1) && near(r.pos.y, 2) && near(r.pos.z, 3), 'identity parent: position unchanged');
  check(near(r.rot.x, 10) && near(r.rot.y, 20) && near(r.rot.z, 30), 'identity parent: rotation unchanged');

  // Unity check: yaw 90° maps +x to -z (left-handed, y-up).
  r = composeTransforms(
    { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 90, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
    { pos: { x: 1, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
  );
  check(near(r.pos.x, 0) && near(r.pos.y, 0) && near(r.pos.z, -1), `yaw 90°: (1,0,0) → (0,0,-1), got (${r.pos.x.toFixed(3)},${r.pos.y.toFixed(3)},${r.pos.z.toFixed(3)})`);
  check(near(r.rot.y, 90), 'yaw 90°: rotation composed to y=90');

  // Parent scale affects child offset AND child scale.
  r = composeTransforms(
    { pos: { x: 10, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0 }, scale: { x: 2, y: 3, z: 4 } },
    { pos: { x: 1, y: 1, z: 1 }, rot: { x: 0, y: 0, z: 0 }, scale: { x: 5, y: 5, z: 5 } }
  );
  check(near(r.pos.x, 12) && near(r.pos.y, 3) && near(r.pos.z, 4), 'parent scale multiplies child offset');
  check(near(r.scale.x, 10) && near(r.scale.y, 15) && near(r.scale.z, 20), 'scales multiply component-wise');
  check(!r.shearRisk, 'no shear risk without child rotation');
  r = composeTransforms(
    { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0 }, scale: { x: 2, y: 3, z: 4 } },
    { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 45, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
  );
  check(r.shearRisk, 'shear risk flagged: non-uniform parent scale + rotated child');

  // Euler → quat → Euler round-trips (values normalized to [0,360)).
  for (const e of [
    { x: 30, y: 60, z: 45 },
    { x: 0, y: 180, z: 0 },
    { x: 350, y: 10, z: 200 },
  ]) {
    const rt = eulerFromQuat(quatFromEuler(e));
    const same = ['x', 'y', 'z'].every((a) => {
      const d = Math.abs(((rt[a] - e[a]) % 360 + 540) % 360 - 180);
      return d < 1e-4;
    });
    check(same, `euler round-trip (${e.x},${e.y},${e.z}) → (${rt.x.toFixed(4)},${rt.y.toFixed(4)},${rt.z.toFixed(4)})`);
  }
}

// -------------------------------------------- 7. scale-limit warning (>50)
console.log('== scale-limit warning');
{
  // Duck-typed level: one parent with big scale, one decoration scaled 2x.
  const mkT = (pos, rot, scale) => ({ pos, rot, scale });
  const parent = {
    id: 42,
    name: 'Big Parent',
    decorationIds: [7],
    transform: mkT({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 30, y: 1, z: 1 }),
    compA: [],
    compB: [],
  };
  const deco = {
    id: 7,
    name: 'Little Deco',
    parentId: 42,
    transform: mkT({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 2, y: 1, z: 1 }),
    compA: [],
    compB: [],
    fields: [],
  };
  const fake = {
    decorations: [deco],
    objectById: (id) => (id === 42 ? parent : undefined),
  };
  const plan = planSplit(fake, [42]);
  check(plan.entries.length === 1, 'fake plan produces one entry');
  check(
    plan.warnings.some((w) => w.code === 'scaleExceeds' && w.params.axes.includes('X: 60') && w.params.max === MAX_SCALE),
    'warns that X scale 60 exceeds 50: ' + JSON.stringify(plan.warnings)
  );
}

// ------------------------------------------- 8. large-file performance
{
  const BIG = 'Cozy Disc Golf.gil';
  let bigBytes = null;
  try {
    bigBytes = new Uint8Array(readFileSync(join(REF, BIG)));
  } catch {
    console.log('== large file: ' + BIG + ' not present, skipped');
  }
  if (bigBytes) {
    console.log('== large file: ' + BIG);
    const { checkParentRemoval } = await import('../js/gil/split.js');
    const container = parseGilContainer(bigBytes);
    const level = parseLevel(container);
    // untouched round-trip
    let t = performance.now();
    const rt = buildGilContainer(container.head, level.encodePayload(), container.suffix);
    check(rt.length === bigBytes.length && rt.every((b, i) => b === bigBytes[i]), `round-trip byte-identical (${(performance.now() - t).toFixed(0)} ms)`);

    const parents = level.objects.filter((o) => o.decorationIds.length);
    const big999 = parents.filter((p) => p.decorationIds.length >= 999);
    check(big999.length >= 3, `${big999.length} parents with ≥999 decorations found`);
    const parentIds = parents.map((p) => p.id);
    const decosBefore = level.decorations.length;
    const objectsBefore = level.objects.length;

    t = performance.now();
    const plan = planSplit(level, parentIds);
    const tPlan = performance.now() - t;
    check(plan.errors.length === 0, `planSplit ok: ${plan.entries.length} entries in ${tPlan.toFixed(0)} ms`);
    check(tPlan < 2000, `planSplit fast enough (${tPlan.toFixed(0)} ms < 2000 ms)`);
    // warnings: only zoom warnings (and structural ones), no shear noise
    const codes = new Set(plan.warnings.map((w) => w.code));
    check(!codes.has('shearRisk'), 'no shear/position/rotation warnings emitted');
    const scaleWarnings = plan.warnings.filter((w) => w.code === 'scaleExceeds');
    check(scaleWarnings.length > 0 && scaleWarnings.length < 20, `zoom>50 warnings present and specific (${scaleWarnings.length})`);
    check(scaleWarnings.every((w) => w.params.name && w.params.parentName && w.params.axes), 'zoom warnings identify object, parent and axes');

    t = performance.now();
    const removal = checkParentRemoval(level, parentIds);
    const tCheck = performance.now() - t;
    check(tCheck < 5000, `checkParentRemoval single-pass fast (${tCheck.toFixed(0)} ms < 5000 ms, was ~230 s)`);

    const snap = {
      obj: level.objectContainerField.raw,
      reg: level.registryContainerField.raw,
      deco: level.decoContainerField.raw,
    };
    t = performance.now();
    let progressCalls = 0;
    const summary = await applySplit(level, plan, {
      collision: true,
      removeParent: true,
      removableParents: removal.removable,
      onProgress: () => progressCalls++,
    });
    const tApply = performance.now() - t;
    check(summary.created.length === plan.entries.length, `applySplit created ${summary.created.length} objects in ${tApply.toFixed(0)} ms`);
    check(tApply < 10000, `applySplit fast enough (${tApply.toFixed(0)} ms < 10 s)`);
    check(progressCalls > 0, `progress callback invoked (${progressCalls}×)`);
    check(summary.removedParents === removal.removable.size, `removed ${summary.removedParents} parents`);

    t = performance.now();
    const out = buildGilContainer(container.head, level.encodePayload(), container.suffix);
    const tSer = performance.now() - t;
    check(tSer < 2000, `serialize fast (${tSer.toFixed(0)} ms)`);
    const re = parseLevel(parseGilContainer(out));
    check(
      re.objects.length === objectsBefore + summary.created.length - summary.removedParents,
      `output valid: ${re.objects.length} objects`
    );
    check(re.decorations.length === decosBefore - summary.removedDecorations, `remaining decorations: ${re.decorations.length}`);
    // spot-check visual preservation: one extracted object per 999-parent
    for (const p of big999.slice(0, 3)) {
      const did = p.decorationIds[0];
      const deco = parseLevel(parseGilContainer(bigBytes)).decorationById(did);
      const created = summary.created.find((c) => c.name === deco.name && c.prefabId === deco.prefabId);
      check(!!created, `extracted object exists for first decoration of "${p.name}"`);
    }
    // undo: snapshot restore → byte-identical original
    level.objectContainerField.raw = snap.obj;
    level.registryContainerField.raw = snap.reg;
    level.decoContainerField.raw = snap.deco;
    level.invalidate();
    const out2 = buildGilContainer(container.head, level.encodePayload(), container.suffix);
    check(out2.length === bigBytes.length && out2.every((b, i) => b === bigBytes[i]), 'undo restores byte-identical 11 MB file');
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall tests passed');
process.exit(failures ? 1 : 0);
