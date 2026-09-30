/**
 * Node test harness for .gil prefab-group detection and ungrouping
 * (GilSession in js/gil-splitter.js). Run:
 *   node tools/test-gil-group.mjs [reference-dir]
 * Uses "Prefab Group.gil" from the reference dir (a level holding one
 * prefab group instance with 8 members); the whole suite is skipped when
 * that file is absent.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseGilContainer, parseMessage, getField, fieldVarint } from '../js/gil/gil.js';
import { parseLevel, COMP_A_PAYLOAD, readComponent } from '../js/gil/model.js';
import { GilSession } from '../js/gil-splitter.js';

const here = dirname(fileURLToPath(import.meta.url));
const REF = process.argv[2] ?? join(here, '..', 'reference', 'reference-samples');
const FILE = join(REF, 'Prefab Group.gil');

let failures = 0;
function check(cond, label) {
  if (cond) console.log('  ok  ' + label);
  else {
    failures++;
    console.error('  FAIL ' + label);
  }
}
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

if (!existsSync(FILE)) {
  console.log(`skipped: ${FILE} not found`);
  process.exit(0);
}
const bytes = new Uint8Array(readFileSync(FILE));
const GROUP = 0x40400001;
const MEMBERS = [0x40400002, 0x40400003, 0x40400004, 0x40400005, 0x40400006, 0x40400007, 0x40400008, 0x40400009];

// raw bytes of a component (list A) of a given type on an object entry
function compRaw(obj, type) {
  for (const cf of obj.compA) {
    const c = readComponent(cf, COMP_A_PAYLOAD);
    if (c.type === type) return cf.raw;
  }
  return null;
}
// object entry bytes with the given component types blanked out, so
// "everything else is identical" can be asserted
function entryWithout(obj, types) {
  const fields = parseMessage(obj.field.raw);
  const kept = fields.filter((f) => {
    if (f.num !== 5 || f.wire !== 2) return true;
    const c = readComponent(f, COMP_A_PAYLOAD);
    return !types.includes(c.type);
  });
  return kept.map((f) => Array.from(f.raw).join(',')).join('|');
}
function rootFieldsExcept(level, skip) {
  return level.root.filter((f) => !skip.includes(f.num)).map((f) => f.raw);
}
function registryKind200Ids(level) {
  const out = [];
  for (const g of level.registryWorldGroups()) out.push(...g.ids);
  return out;
}
function reload(session) {
  const out = session.serialize();
  return { out, session: new GilSession(out) };
}

// ------------------------------------------------------------ 1. detection
console.log('== detection');
const s0 = new GilSession(bytes);
{
  check(s0.groupCount() === 1, 'exactly one prefab group detected');
  check(s0.isGroup(GROUP), `object 0x${GROUP.toString(16)} is the group`);
  const members = s0.groupMembers(GROUP);
  check(members.length === 8, '8 members listed');
  check(same(members.map((m) => m.id), MEMBERS), 'members in child-list order');
  check(members.every((m) => !m.isGroup), 'no nested groups in this sample');
  check(members[1].count === 50 && members[2].count === 82, 'member decoration counts read through (50, 82)');
  const rows = s0.objects({ parentsOnly: true });
  const grow = rows.find((r) => r.id === GROUP);
  check(!!grow && grow.isGroup && grow.memberCount === 8 && grow.count === 0, 'object list includes the group with memberCount 8');
  check(rows.filter((r) => r.groupId === GROUP).length === 7, 'members with decorations report their group id (7 of 8 hold decorations)');
  const pts = s0.groupMemberPoints(GROUP);
  const m0 = s0.level.objectById(MEMBERS[0]).transform.pos;
  check(pts.length === 8 && pts[0].x === m0.x && pts[0].y === m0.y && pts[0].z === m0.z, 'member points use the stored (world) transforms');
  check(!s0.changed && same(s0.serialize(), bytes), 'untouched session serializes byte-identically');
}

// ------------------------------------------------------- 2. partial ungroup
console.log('== partial ungroup (2 members)');
{
  const s = new GilSession(bytes);
  const before = parseLevel(parseGilContainer(bytes));
  const res = s.ungroup(GROUP, [MEMBERS[1], MEMBERS[4]]);
  check(res.count === 2 && !res.removedGroup && res.kept === null, 'result: 2 freed, group kept');
  check(same(res.freedIds, [MEMBERS[1], MEMBERS[4]]), 'freed ids reported in child-list order');
  check(s.edits === 1 && s.canUndo, 'one undoable edit');

  const L = s.level;
  check(s.isGroup(GROUP) && s.groupMembers(GROUP).length === 6, 'group now lists 6 members');
  check(same(s.groupMembers(GROUP).map((m) => m.id), MEMBERS.filter((_, i) => i !== 1 && i !== 4)), 'remaining members keep their order');

  // freed members: membership component emptied, everything else identical
  for (const id of [MEMBERS[1], MEMBERS[4]]) {
    const o = L.objectById(id);
    const b = before.objectById(id);
    check(same(compRaw(o, 62), [0x08, 0x3e, 0x92, 0x04, 0x00]), `0x${id.toString(16)}: membership component is {1:62, 66:{}}`);
    check(entryWithout(o, [62]) === entryWithout(b, [62]), `0x${id.toString(16)}: every other byte of the entry survives`);
  }
  // untouched members and every other object are byte-identical
  for (const b of before.objects) {
    if (b.id === GROUP || b.id === MEMBERS[1] || b.id === MEMBERS[4]) continue;
    const o = L.objectById(b.id);
    check(!!o && same(o.field.raw, b.field.raw), `0x${b.id.toString(16)}: untouched entry byte-identical`);
  }
  // group: only the child list changed
  const g = L.objectById(GROUP);
  const gb = before.objectById(GROUP);
  check(entryWithout(g, [61]) === entryWithout(gb, [61]), 'group: only the child list component changed');
  const kids = parseMessage(getField(parseMessage(compRaw(g, 61)), 65).raw).filter((f) => f.num === 1);
  check(kids.length === 6, 'group child list holds 6 records');
  // the kept records are byte-identical to the originals
  const kidsBefore = parseMessage(getField(parseMessage(compRaw(gb, 61)), 65).raw).filter((f) => f.num === 1);
  const keptBefore = kidsBefore.filter((_, i) => i !== 1 && i !== 4);
  check(kids.every((k, i) => same(k.raw, keptBefore[i].raw)), 'kept child records byte-identical');
  // nothing else in the file changed
  const ra = rootFieldsExcept(L, [5]);
  const rb = rootFieldsExcept(before, [5]);
  check(ra.length === rb.length && ra.every((r, i) => same(r, rb[i])), 'every root field other than the object container is byte-identical');
  check(same(registryKind200Ids(L), registryKind200Ids(before)), 'registry untouched on a partial ungroup');

  // undo restores the input exactly
  s.undo();
  check(same(s.serialize(), bytes), 'undo restores the original bytes');
  s.redo();
  check(s.groupMembers(GROUP).length === 6, 'redo re-applies the ungroup');

  // reload the output: same picture
  const { session: s2 } = reload(s);
  check(s2.isGroup(GROUP) && s2.groupMembers(GROUP).length === 6, 'reloaded output: group with 6 members');
  check(!s2.isGroup(MEMBERS[1]) && s2.objects().find((r) => r.id === MEMBERS[1]).groupId === null, 'reloaded output: freed member is standalone');
}

// ---------------------------------------------------------- 3. ungroup all
console.log('== ungroup all');
{
  const s = new GilSession(bytes);
  const before = parseLevel(parseGilContainer(bytes));
  const res = s.ungroup(GROUP);
  check(res.count === 8 && res.removedGroup && res.kept === null, 'result: 8 freed, group removed');
  const L = s.level;
  check(!L.objectById(GROUP), 'group object gone from the object container');
  check(L.objects.length === before.objects.length - 1, 'object count dropped by one');
  check(s.groupCount() === 0, 'no group left');
  for (const id of MEMBERS) {
    const o = L.objectById(id);
    const b = before.objectById(id);
    check(!!o && same(compRaw(o, 62), [0x08, 0x3e, 0x92, 0x04, 0x00]) && entryWithout(o, [62]) === entryWithout(b, [62]), `0x${id.toString(16)}: freed, only membership emptied`);
  }
  const ids200 = registryKind200Ids(L);
  const ids200b = registryKind200Ids(before);
  check(!ids200.includes(GROUP) && ids200.length === ids200b.length - 1, 'registry: the group\'s world-object item removed, nothing else');
  check(same(ids200, ids200b.filter((x) => x !== GROUP)), 'registry: remaining items keep their order');
  const ra = rootFieldsExcept(L, [5, 6]);
  const rb = rootFieldsExcept(before, [5, 6]);
  check(ra.length === rb.length && ra.every((r, i) => same(r, rb[i])), 'every other root field byte-identical (prefab library untouched)');
  // object order of the survivors is unchanged
  const order = L.objects.map((o) => o.id);
  check(same(order, before.objects.map((o) => o.id).filter((x) => x !== GROUP)), 'surviving objects keep their file order');

  s.undo();
  check(same(s.serialize(), bytes), 'undo restores the original bytes');
  s.redo();
  const { out, session: s2 } = reload(s);
  check(s2.groupCount() === 0 && !s2.level.objectById(GROUP), 'reloaded output has no group');
  check(s2.level.objects.length === before.objects.length - 1, 'reloaded output object count');
  check(same(new GilSession(out).serialize(), out), 'output round-trips byte-identically');
}

// ------------------------------------------ 4. stepwise equals all-at-once
console.log('== stepwise ungroup equals ungroup all');
{
  const all = new GilSession(bytes);
  all.ungroup(GROUP);
  const step = new GilSession(bytes);
  step.ungroup(GROUP, [MEMBERS[7], MEMBERS[0]]);
  step.ungroup(GROUP, [MEMBERS[3]]);
  step.ungroup(GROUP); // the rest
  check(step.edits === 3 && step.groupCount() === 0, 'three edits, group dissolved');
  check(same(step.serialize(), all.serialize()), 'three partial ungroups produce the same bytes as one full ungroup');
  step.undo();
  step.undo();
  step.undo();
  check(same(step.serialize(), bytes), 'three undos restore the input');
}

// -------------------------------------------------------------- 5. errors
console.log('== validation');
{
  const s = new GilSession(bytes);
  let threw = null;
  try { s.ungroup(MEMBERS[0]); } catch (e) { threw = e; }
  check(threw && threw.i18n?.key === 'err.notGroup', 'ungrouping a non-group throws err.notGroup');
  threw = null;
  try { s.ungroup(GROUP, [0x40400099]); } catch (e) { threw = e; }
  check(threw && threw.i18n?.key === 'err.selectMember', 'unknown member ids throw err.selectMember');
  check(!s.changed && same(s.serialize(), bytes), 'failed calls change nothing');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall prefab-group tests passed');
process.exit(failures ? 1 : 0);
