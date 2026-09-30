// GIA / GIL Splitter: one interactive editor for both file types.
// .gia: import → pick a model → select Decoration entries (click / Ctrl /
//   Shift) → Split selected → repeat as needed → download.
// .gil: import → check parent objects → select attached decorations →
//   Separate (selected / all from selected parents) → download.
// The UI adapts to the loaded file type (body.mode-gia / body.mode-gil);
// panels, viewer, toasts, dialogs and the export bar are shared.
// All editing is byte-preserving; see js/gia-splitter.js and js/gil-splitter.js.
// All user-facing text goes through js/i18n.js (t/tn/num + data-i18n).

import { GiaSession, MAX_DECORATIONS_PER_MODEL } from './gia-splitter.js';
import { GilSession, MAX_SCALE, MAX_DECORATIONS_PER_PARENT } from './gil-splitter.js';
import { DecorationViewer } from './viewer3d.js';
import { t, tn, num, LANGS, currentLang, setLanguage, initI18n, onLangChange, setI18nVariant } from './i18n.js';

const $ = (id) => document.getElementById(id);

const els = {
  fileInput: $('file-input'), btnOpen: $('btn-open'), btnOpenHero: $('btn-open-hero'),
  dropzone: $('dropzone'), workbench: $('workbench'),
  fileMeta: $('file-meta'), metaName: $('meta-name'), metaStats: $('meta-stats'),
  modelCount: $('model-count'), modelList: $('model-list'),
  detailName: $('detail-name'), detailCount: $('detail-count'),
  btnSelectAll: $('btn-select-all'), btnSelectNone: $('btn-select-none'),
  btnMoveUp: $('btn-move-up'), btnMoveDown: $('btn-move-down'),
  tableWrap: $('dec-table-wrap'),
  splitInfo: $('split-info'), btnSplit: $('btn-split'),
  detailPanel: $('detail-panel'), groupInfo: $('group-info'),
  btnUngroupSel: $('btn-ungroup-sel'), btnUngroupAll: $('btn-ungroup-all'),
  decBody: $('dec-table').querySelector('tbody'),
  exportBar: $('export-bar'), exModels: $('ex-models'), exSelected: $('ex-selected'),
  exSplits: $('ex-splits'), exSize: $('ex-size'), setName: $('set-name'),
  btnModelsAll: $('btn-models-all'), btnModelsNone: $('btn-models-none'),
  exportCount: $('export-count'),
  btnReset: $('btn-reset'), btnDownload: $('btn-download'), toast: $('toast'),
  langSelect: $('lang-select'),
  btnRenameSel: $('btn-rename-sel'), renamePop: $('rename-pop'), renamePopInput: $('rename-pop-input'),
  vViewport: $('v-viewport'), vSearch: $('v-search'), vStats: $('v-stats'), vCoords: $('v-coords'),
  vFrameSel: $('v-frame-sel'), vFrameAll: $('v-frame-all'), vGrid: $('v-grid'), vAxes: $('v-axes'),
  vLabels: $('v-labels'), vSize: $('v-size'), vColorSel: $('v-color-sel'), vColorUnsel: $('v-color-unsel'),
  vHideSel: $('v-hide-sel'), vHideUnsel: $('v-hide-unsel'), vIsolate: $('v-isolate'), vShowAll: $('v-show-all'),
  // .gil mode
  objSort: $('obj-sort'), objSearch: $('obj-search'), objShowAll: $('obj-show-all'),
  gilOpInfo: $('gil-op-info'),
  btnGilUndo: $('btn-gil-undo'), btnGilRedo: $('btn-gil-redo'),
  btnGilSplitSel: $('btn-gil-split-sel'), btnGilSplitParents: $('btn-gil-split-parents'),
  gilOptCollision: $('gil-opt-collision'), gilOptRemoveParent: $('gil-opt-remove-parent'),
  // shared dialogs / progress
  confirmModal: $('confirm-modal'), cmHead: $('cm-head'), cmBody: $('cm-body'),
  cmOk: $('cm-ok'), cmCancel: $('cm-cancel'),
  errorModal: $('error-modal'), emBody: $('em-body'), emClose: $('em-close'),
  progressOverlay: $('progress-overlay'), progressLabel: $('progress-label'), progressBar: $('progress-bar'),
};

// Extraction options persist between sessions; the keys predate the unified
// editor and stay stable so saved settings survive.
const COLLISION_PREF_KEY = 'gil-splitter-extract-collision';
const REMOVE_PARENT_PREF_KEY = 'gil-splitter-remove-parent';
function loadPref(key, dflt) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? dflt : v === '1';
  } catch { return dflt; }
}
function savePref(key, on) {
  try { localStorage.setItem(key, on ? '1' : '0'); } catch {}
}

const state = {
  mode: null,         // 'gia' | 'gil', set when a file is loaded
  sourceBytes: null,  // as loaded, for Reset
  fileName: '',
  session: null,      // GiaSession (.gia mode)
  currentModel: 0,
  sel: new Set(),     // selected row indices in the current model
  selByModel: new Map(), // model uid -> saved Set of indices (selection memory)
  anchor: null,       // shift-selection anchor
  rows: [],           // <tr> per decoration index
  exportSel: new Set(), // uids of models included in the export
  viewer: null,       // DecorationViewer (created on first session, shared by both modes)
  viewerModel: -1,    // model the viewer currently shows (for frame-on-switch)
  history: { undo: [], redo: [] }, // rename operations
  gil: {
    session: null,      // GilSession (.gil mode)
    parentSel: new Set(), // checked parent-object ids (extraction targets)
    parentAnchor: null, // shift-range anchor in the object list
    active: null,       // focused parent id (its decorations fill the table)
    decoSel: new Set(), // selected decoration ids; persists across parents
    decoAnchor: null,   // shift-range anchor in the decoration table
    pointIds: [],       // viewer point index -> decoration id (focused parent)
    viewerParent: null, // parent the viewer currently shows
    showAll: false,
    search: '',
    sortKey: 'deco',    // object list sort
    sortAsc: false,
    decoSort: null,     // decoration table sort column (null = file order)
    decoSortAsc: true,
    collision: loadPref(COLLISION_PREF_KEY, true),
    removeParent: loadPref(REMOVE_PARENT_PREF_KEY, false),
  },
};

// ---------- language ----------

for (const l of LANGS) {
  const opt = document.createElement('option');
  opt.value = l.code;
  opt.textContent = l.name; // native names, never translated
  els.langSelect.appendChild(opt);
}
els.langSelect.addEventListener('change', () => setLanguage(els.langSelect.value));

// size the dropdown to the current selection, not the longest option
const langMeasure = document.createElement('canvas').getContext('2d');
function fitLangSelect() {
  const opt = els.langSelect.selectedOptions[0];
  if (!opt) return;
  const cs = getComputedStyle(els.langSelect);
  langMeasure.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const text = langMeasure.measureText(opt.textContent).width;
  const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  els.langSelect.style.width = `${Math.ceil(text + pad) + 4}px`;
}
document.fonts?.ready.then(fitLangSelect);

onLangChange(() => {
  els.langSelect.value = currentLang();
  fitLangSelect();
  if (state.session || state.gil.session) {
    renderMeta();
    renderAll();
  }
});

initI18n().then(() => {
  els.langSelect.value = currentLang();
  fitLangSelect();
});

// localized message for engine/UI errors (engine errors carry err.i18n codes)
const errMsg = (err, fallbackKey) =>
  err?.i18n ? t(err.i18n.key, err.i18n.params) : t(fallbackKey);

// ---------- file loading ----------

const openPicker = () => els.fileInput.click();
els.btnOpen.addEventListener('click', openPicker);
els.btnOpenHero.addEventListener('click', openPicker);
els.fileInput.addEventListener('change', () => {
  if (els.fileInput.files[0]) loadFile(els.fileInput.files[0]);
  els.fileInput.value = '';
});

// The file-import overlay reacts ONLY to external file drags. Internal UI
// drags (decoration reordering) carry 'text/plain', not 'Files', and are
// additionally flagged via drag.indices, so they never touch the overlay.
const isFileDrag = (e) =>
  !drag.indices && [...(e.dataTransfer?.types ?? [])].includes('Files');

let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  if (++dragDepth === 1) document.body.classList.add('dragging');
});
document.addEventListener('dragleave', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  if (--dragDepth === 0) document.body.classList.remove('dragging');
});
document.addEventListener('dragover', (e) => { if (isFileDrag(e)) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

// Route by extension; each session constructor validates the content before
// any state is committed, so a bad file never clobbers the loaded document.
async function loadFile(file) {
  const isGil = /\.gil$/i.test(file.name);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (isGil) {
      const session = new GilSession(bytes);
      state.sourceBytes = bytes;
      state.fileName = file.name.replace(/\.gil$/i, '');
      startGilSession(session);
    } else {
      const session = new GiaSession(bytes);
      state.sourceBytes = bytes;
      state.fileName = file.name.replace(/\.gia$/i, '');
      startSession(session);
    }
  } catch (err) {
    console.error(err);
    if (isGil) {
      // .gil container errors are descriptive, so show them in the dialog
      showError(
        `<p><b>${escapeHtml(t('gil.load.failTitle', { name: file.name }))}</b></p>` +
        `<p class="e">${escapeHtml(err.message)}</p>` +
        `<p>${escapeHtml(t('gil.load.failNote'))}</p>`
      );
    } else {
      toast(errMsg(err, 'err.readFail'));
    }
  }
}

// The loaded file type drives visibility (.gia-only/.gil-only elements) and
// mode-dependent static labels (data-i18n-gil overrides).
function setMode(mode) {
  state.mode = mode;
  document.body.classList.toggle('mode-gia', mode === 'gia');
  document.body.classList.toggle('mode-gil', mode === 'gil');
  setI18nVariant(mode === 'gil' ? 'gil' : null);
}

function startSession(session) {
  setMode('gia');
  state.gil.session = null;
  state.session = session;
  state.currentModel = 0;
  state.sel = new Set();
  state.selByModel = new Map();
  state.anchor = null;
  state.viewerModel = -1; // force a camera re-frame for the new project
  state.history = { undo: [], redo: [] };
  // a new project starts with every model included in the export
  state.exportSel = new Set(session.models.map((m) => m.uid));
  ensureViewer();

  renderMeta();
  els.setName.value = t('export.defaultName', { base: baseName() });

  els.dropzone.classList.add('hidden');
  els.workbench.classList.remove('hidden');
  els.exportBar.classList.remove('hidden');
  renderAll();
}

function startGilSession(session) {
  setMode('gil');
  state.session = null;
  els.detailPanel.classList.remove('group-view');
  const g = state.gil;
  g.session = session;
  g.parentSel = new Set();
  g.parentAnchor = null;
  g.active = null;
  g.decoSel = new Set();
  g.decoAnchor = null;
  g.pointIds = [];
  g.viewerParent = null;
  g.search = '';
  els.objSearch.value = '';
  els.objShowAll.checked = g.showAll;
  els.objSort.value = g.sortKey;
  els.gilOptCollision.checked = g.collision;
  els.gilOptRemoveParent.checked = g.removeParent;
  ensureViewer();

  renderMeta();
  els.setName.value = t('export.defaultName', { base: baseName() });

  els.dropzone.classList.add('hidden');
  els.workbench.classList.remove('hidden');
  els.exportBar.classList.remove('hidden');
  renderAll();
}

function baseName() {
  if (state.mode === 'gil') return state.fileName;
  return state.session?.meta.exportName || state.fileName;
}

function renderMeta() {
  if (state.mode === 'gil') {
    const s = state.gil.session;
    els.metaName.textContent = `${state.fileName}.gil`;
    const parts = [
      `${t('gil.objects.title')}: ${num(s.level.objects.length)}`,
      `${t('gil.st.decos')}: ${num(s.level.decorations.length)}`,
    ];
    if (s.meta.levelName) parts.push(`${t('gil.st.levelName')}: ${s.meta.levelName}`);
    if (s.meta.gameVersion) parts.push(`${t('gil.st.version')}: ${s.meta.gameVersion}`);
    els.metaStats.textContent = parts.join(' · ');
  } else {
    const meta = state.session.meta;
    els.metaName.textContent = baseName();
    els.metaStats.textContent = [
      tn('meta.models', meta.modelsBefore),
      tn('meta.entries', meta.decorationEntries),
      t('meta.engine', { v: meta.engineVersion || '?' }),
    ].join(' · ');
  }
  els.fileMeta.classList.remove('hidden');
}

// ---------- model list (master) ----------

function renderModels(highlightId = null) {
  const models = state.session.models;
  const flash = new Set(Array.isArray(highlightId) ? highlightId : highlightId == null ? [] : [highlightId]);
  els.modelCount.textContent = num(models.length);
  els.modelList.textContent = '';
  const frag = document.createDocumentFragment();
  for (const m of models) {
    const exported = state.exportSel.has(m.uid);
    const row = document.createElement('div');
    row.className = 'model-row'
      + (m.id === state.currentModel ? ' active' : '')
      + (exported ? '' : ' excluded')
      + (flash.has(m.id) ? ' flash' : '');
    row.dataset.uid = m.uid;
    row.addEventListener('click', () => selectModel(m.id));

    // export inclusion, independent from which model is open for viewing
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'model-export';
    cb.checked = exported;
    cb.title = t('models.includeTip');
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      if (cb.checked) state.exportSel.add(m.uid);
      else state.exportSel.delete(m.uid);
      row.classList.toggle('excluded', !cb.checked);
      renderExport();
    });

    const name = document.createElement('span');
    name.className = 'model-name';
    name.textContent = m.name || t('model.unnamed');
    name.title = `${m.name} · ${t('rename.tip')}`;
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      renameModelInline(name, m.id);
    });

    // model rows accept decoration drags from the table (move between models);
    // targets that would exceed the per-model limit show as invalid instead
    row.addEventListener('dragover', (e) => {
      if (!drag.indices || m.id === state.currentModel) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      // entity groups hold no Decoration list of their own
      const overflow = m.isGroup || m.count + drag.indices.length > MAX_DECORATIONS_PER_MODEL;
      row.classList.add(overflow ? 'drop-invalid' : 'drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target', 'drop-invalid'));
    row.addEventListener('drop', (e) => {
      if (!drag.indices || m.id === state.currentModel || m.isGroup) return;
      e.preventDefault();
      e.stopPropagation();
      const indices = drag.indices;
      endDrag();
      drag.indices = indices; // moveSelectionToModel reads them
      moveSelectionToModel(m.id);
      drag.indices = null;
    });

    const badges = document.createElement('span');
    badges.className = 'model-badges';
    if (m.isNew) {
      const tag = document.createElement('span');
      tag.className = 'tag-new';
      tag.textContent = t('tag.new');
      badges.appendChild(tag);
    }
    if (m.hasGraph) {
      const tag = document.createElement('span');
      tag.className = 'tag-graph';
      tag.textContent = t('tag.graph');
      tag.title = t('tag.graphTip');
      badges.appendChild(tag);
    }
    if (m.isGroup) {
      const tag = document.createElement('span');
      tag.className = 'tag-group';
      tag.textContent = t('tag.group');
      tag.title = t('tag.groupTip');
      badges.appendChild(tag);
    }
    const count = document.createElement('span');
    count.className = 'model-count';
    // a group's pill counts its member entities, not Decoration entries
    count.textContent = num(m.isGroup ? m.memberCount : m.count);
    count.title = m.isGroup ? tn('model.membersTip', m.memberCount) : tn('model.countTip', m.count);
    badges.appendChild(count);

    row.append(cb, name, badges);
    frag.appendChild(row);
  }
  els.modelList.appendChild(frag);
  updateGiaSelDots();
}

// Sidebar indicator: models that hold selected entries keep a dot, so
// selections parked in other models stay visible while browsing.
function updateGiaSelDots() {
  const { total, models } = giaSelectionTotals();
  const title = t('sel.acrossModels', { n: num(total), k: num(models) });
  for (const row of els.modelList.querySelectorAll('.model-row')) {
    const uid = Number(row.dataset.uid);
    const m = state.session.models.find((x) => x.uid === uid);
    const set = m && m.id === state.currentModel ? state.sel : state.selByModel.get(uid);
    const has = !!set && set.size > 0;
    let dot = row.querySelector('.sel-dot');
    if (has && !dot) {
      dot = document.createElement('span');
      dot.className = 'sel-dot';
      row.querySelector('.model-badges')?.appendChild(dot);
    } else if (!has && dot) {
      dot.remove();
      dot = null;
    }
    if (dot) dot.title = title;
  }
}

// Select all / none: export inclusion in .gia mode, extraction targets in .gil
els.btnModelsAll.addEventListener('click', () => {
  if (state.mode === 'gil') {
    for (const o of visibleGilObjects()) if (o.eligible) state.gil.parentSel.add(o.id);
    renderGilModels();
    renderGilDetail();
    renderGilOps();
    return;
  }
  state.exportSel = new Set(state.session.models.map((m) => m.uid));
  renderModels();
  renderExport();
});
els.btnModelsNone.addEventListener('click', () => {
  if (state.mode === 'gil') {
    state.gil.parentSel.clear();
    renderGilModels();
    renderGilDetail();
    renderGilOps();
    return;
  }
  state.exportSel.clear();
  renderModels();
  renderExport();
});

// Switching the viewed model never discards selections: each model's
// selection is remembered (keyed by its stable uid) and restored on return.
function selectModel(id) {
  if (id === state.currentModel) return;
  const prevUid = state.session.models[state.currentModel]?.uid;
  if (prevUid !== undefined) state.selByModel.set(prevUid, new Set(state.sel));
  state.currentModel = id;
  state.sel = new Set(state.selByModel.get(state.session.models[id]?.uid) ?? []);
  state.anchor = null;
  renderModels();
  renderDetail();
}

// Selection totals across every model (current model reads live state.sel).
function giaSelectionTotals() {
  let total = 0;
  let models = 0;
  for (const m of state.session.models) {
    const set = m.id === state.currentModel ? state.sel : state.selByModel.get(m.uid);
    const n = set ? set.size : 0;
    if (n) {
      total += n;
      models++;
    }
  }
  return { total, models };
}

// ---------- decoration table (detail) ----------

function renderDetail() {
  const model = state.session.models[state.currentModel];
  els.detailPanel.classList.toggle('group-view', !!model.isGroup);
  if (model.isGroup) return renderGroupDetail(model);
  const decs = state.session.decorations(state.currentModel);

  els.detailName.textContent = model.name || t('model.unnamed');
  els.detailName.title = t('rename.tip');
  els.detailName.ondblclick = () => renameModelInline(els.detailName, state.currentModel);
  els.detailCount.textContent = tn('detail.entries', decs.length);

  els.decBody.textContent = '';
  state.rows = [];
  const frag = document.createDocumentFragment();
  for (const d of decs) {
    const tr = document.createElement('tr');
    tr.dataset.index = d.index;
    tr.draggable = true;
    tr.addEventListener('dragstart', (e) => onDragStart(d.index, e));
    tr.addEventListener('dragover', (e) => onDragOver(d.index, tr, e));
    tr.addEventListener('drop', (e) => onDrop(e));
    tr.addEventListener('dragend', endDrag);

    const tdDrag = document.createElement('td');
    tdDrag.className = 'col-drag';
    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.textContent = '⠿';
    handle.title = t('reorder.dragTip');
    tdDrag.appendChild(handle);

    const tdCheck = document.createElement('td');
    tdCheck.className = 'col-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.tabIndex = -1;
    cb.addEventListener('click', (e) => { e.stopPropagation(); toggleRow(d.index); });
    tdCheck.appendChild(cb);

    const tdIdx = document.createElement('td');
    tdIdx.className = 'num muted';
    tdIdx.textContent = d.index; // position identifier, never locale-formatted

    const tdName = document.createElement('td');
    tdName.className = 'dec-name';
    if (d.name) tdName.textContent = d.name;
    else { tdName.textContent = '-'; tdName.classList.add('muted'); }
    tdName.title = t('rename.tip');
    tdName.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startInlineRename(tdName, d.name ?? '', (v) => {
        // routed through the bulk API so single renames are undoable too
        commitRenameOp([d.index], v);
      });
    });

    const tdId = document.createElement('td');
    tdId.className = 'num dec-id';
    if (d.guid != null) tdId.textContent = d.guid; // identifier, so no digit grouping
    else { tdId.textContent = '-'; tdId.classList.add('muted'); }

    tr.append(tdDrag, tdCheck, tdIdx, tdName, tdId);
    tr.addEventListener('click', (e) => onRowClick(d.index, e));
    state.rows.push(tr);
    frag.appendChild(tr);
  }
  els.decBody.appendChild(frag);
  updateViewerData();
  syncSelection();
}

// Entity-group view: the table lists the group's member entities (position
// in the group, name with its Decoration count, entity id). Rows share the
// toggle/range selection machinery with the Decoration table; the ops bar
// offers "Ungroup selected" / "Ungroup all" instead of splitting.
function renderGroupDetail(model) {
  const members = state.session.groupMembers(state.currentModel);
  els.detailName.textContent = model.name || t('model.unnamed');
  els.detailName.title = t('rename.tip');
  els.detailName.ondblclick = () => renameModelInline(els.detailName, state.currentModel);
  els.detailCount.textContent = tn('group.members', members.length);

  els.decBody.textContent = '';
  state.rows = [];
  const frag = document.createDocumentFragment();
  for (const x of members) {
    const tr = document.createElement('tr');
    tr.dataset.index = x.index;

    const tdDrag = document.createElement('td');
    tdDrag.className = 'col-drag';

    const tdCheck = document.createElement('td');
    tdCheck.className = 'col-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.tabIndex = -1;
    cb.addEventListener('click', (e) => { e.stopPropagation(); toggleRow(x.index); });
    tdCheck.appendChild(cb);

    const tdIdx = document.createElement('td');
    tdIdx.className = 'num muted';
    tdIdx.textContent = x.index;

    const tdName = document.createElement('td');
    tdName.className = 'dec-name';
    if (x.name) tdName.textContent = x.name;
    else { tdName.textContent = '-'; tdName.classList.add('muted'); }
    const count = document.createElement('span');
    count.className = 'member-count';
    count.textContent = num(x.count);
    count.title = tn('model.countTip', x.count);
    tdName.appendChild(count);
    if (x.isGroup) {
      const tag = document.createElement('span');
      tag.className = 'tag-group';
      tag.textContent = t('tag.group');
      tdName.appendChild(tag);
    }
    if (x.hasGraph) {
      const tag = document.createElement('span');
      tag.className = 'tag-graph';
      tag.textContent = t('tag.graph');
      tdName.appendChild(tag);
    }

    const tdId = document.createElement('td');
    tdId.className = 'num dec-id';
    tdId.textContent = x.guid; // identifier, so no digit grouping

    tr.append(tdDrag, tdCheck, tdIdx, tdName, tdId);
    tr.addEventListener('click', (e) => onRowClick(x.index, e));
    state.rows.push(tr);
    frag.appendChild(tr);
  }
  els.decBody.appendChild(frag);
  updateViewerData();
  syncSelection();
}

// push the current model's points into the 3D viewer; the camera re-frames
// only when the viewed model actually changed. A group shows one point per
// member entity (at its world position) instead of decorations.
function updateViewerData() {
  if (!state.viewer) return;
  const frame = state.viewerModel !== state.currentModel;
  state.viewerModel = state.currentModel;
  state.viewer.setData(giaViewerPoints(), { frame });
  applySearch();
}

// points shown for the current .gia model: its decorations, or, for an
// entity group, its member entities
function giaViewerPoints() {
  const model = state.session.models[state.currentModel];
  return model?.isGroup
    ? state.session.groupMemberPoints(state.currentModel)
    : state.session.decorationPoints(state.currentModel);
}

function applySearch() {
  if (!state.viewer) return;
  const hits = state.viewer.setSearch(els.vSearch.value);
  for (const tr of state.rows) {
    tr.classList.toggle('search-hit', hits.has(Number(tr.dataset.index)));
  }
}

// Toggle-based selection: a click toggles just that row (it never resets
// the rest of the selection) and Shift+click INVERTS every row between the
// anchor and the click (anchor excluded: its click already toggled it). So
// toggling a row on and shift-clicking selects the whole range, toggling it
// off and shift-clicking deselects the whole range.
function onRowClick(i, e) {
  if (e.shiftKey && state.anchor != null) {
    const [a, b] = [Math.min(state.anchor, i), Math.max(state.anchor, i)];
    for (let k = a; k <= b; k++) {
      if (k === state.anchor) continue;
      if (state.sel.has(k)) state.sel.delete(k);
      else state.sel.add(k);
    }
    syncSelection();
    return;
  }
  toggleRow(i); // plain and Ctrl+click both toggle (sets the anchor)
}

function toggleRow(i) {
  if (state.sel.has(i)) state.sel.delete(i);
  else state.sel.add(i);
  state.anchor = i;
  syncSelection();
}

els.btnSelectAll.addEventListener('click', () => {
  if (state.mode === 'gil') {
    const parent = effectiveGilParent();
    if (!parent) return;
    for (const did of parent.decorationIds) state.gil.decoSel.add(did);
    syncGilSelection();
    return;
  }
  state.sel = new Set(state.rows.map((_, i) => i));
  syncSelection();
});
els.btnSelectNone.addEventListener('click', () => {
  if (state.mode === 'gil') {
    state.gil.decoSel.clear();
    syncGilSelection();
    return;
  }
  state.sel.clear();
  syncSelection();
});

function syncSelection() {
  for (const tr of state.rows) {
    const i = Number(tr.dataset.index);
    const sel = state.sel.has(i);
    tr.classList.toggle('selected', sel);
    tr.querySelector('input').checked = sel;
  }
  const n = state.sel.size;
  const model = state.session.models[state.currentModel];
  if (state.viewer) {
    state.viewer.setSelection(state.sel);
    updateViewerStats();
  }
  if (model?.isGroup) {
    // member rows: only ungrouping applies (no reorder/rename/split)
    els.btnMoveUp.disabled = els.btnMoveDown.disabled = els.btnRenameSel.disabled = true;
    els.btnSplit.disabled = true;
    els.btnUngroupSel.disabled = n === 0;
    els.btnUngroupSel.textContent = n ? t('group.buttonN', { n: num(n) }) : t('group.button');
    if (n === 0) {
      els.groupInfo.innerHTML = escapeHtml(t('group.none'));
      els.groupInfo.classList.remove('armed');
    } else {
      els.groupInfo.innerHTML = t('group.info', {
        n: num(n),
        total: num(state.rows.length),
        name: escapeHtml(model.name || t('model.unnamed')),
      });
      els.groupInfo.classList.add('armed');
    }
    updateGiaSelDots();
    return;
  }
  els.btnMoveUp.disabled = n === 0;
  els.btnMoveDown.disabled = n === 0;
  els.btnRenameSel.disabled = n === 0;
  els.btnSplit.disabled = n === 0;
  els.btnSplit.textContent = n ? t('split.buttonN', { n: num(n) }) : t('split.button');
  // selections parked in other models are preserved; surface them so
  // switching the viewed model clearly never discards work
  const totals = giaSelectionTotals();
  const across = totals.total > n
    ? ` <span class="muted">· ${escapeHtml(t('sel.acrossModels', { n: num(totals.total), k: num(totals.models) }))}</span>`
    : '';
  if (n === 0) {
    els.splitInfo.innerHTML = escapeHtml(t('split.none')) + across;
    els.splitInfo.classList.remove('armed');
  } else {
    const target = state.session.previewSplitName(state.currentModel);
    els.splitInfo.innerHTML = t('split.info', {
      n: num(n),
      total: num(state.rows.length),
      name: escapeHtml(target),
    }) + across;
    els.splitInfo.classList.add('armed');
  }
  updateGiaSelDots();
}

// ---------- reordering (drag-and-drop + arrow buttons) ----------

const drag = { indices: null, target: null, marked: null };

function onDragStart(i, e) {
  if (state.mode === 'gil') {
    // dragging a selected row moves the focused parent's selected rows (the
    // id-based cross-parent selection itself is untouched); dragging an
    // unselected row moves just that row without altering the selection
    const g = state.gil;
    const rowSelected = g.decoSel.has(Number(state.rows[i]?.dataset.decoId));
    drag.indices = rowSelected
      ? state.rows
          .filter((tr) => g.decoSel.has(Number(tr.dataset.decoId)))
          .map((tr) => Number(tr.dataset.index))
          .sort((a, b) => a - b)
      : [i];
  } else {
    // dragging a selected row moves the whole selection; otherwise just this row
    if (!state.sel.has(i)) {
      state.sel = new Set([i]);
      state.anchor = i;
      syncSelection();
    }
    drag.indices = [...state.sel].sort((a, b) => a - b);
  }
  e.dataTransfer.setData('text/plain', '');
  e.dataTransfer.effectAllowed = 'move';
  for (const idx of drag.indices) state.rows[idx]?.classList.add('dragging');
  if (state.mode === 'gil') {
    // other world objects light up as drop targets; those the move would
    // push past the per-parent limit are dimmed immediately
    els.modelList.classList.add('dec-drag');
    for (const row of els.modelList.querySelectorAll('.model-row')) {
      markGilDropTarget(row, Number(row.dataset.objId));
    }
    return;
  }
  els.modelList.classList.add('dec-drag'); // other models light up as drop targets
  // immediately dim models that cannot accept this many entries (and entity
  // groups, which hold no Decoration list at all)
  const models = state.session.models;
  [...els.modelList.querySelectorAll('.model-row')].forEach((row, i) => {
    const m = models[i];
    if (m && m.id !== state.currentModel && m.isGroup) {
      row.classList.add('drop-full');
      row.title = t('group.noDropTip');
    } else if (m && m.id !== state.currentModel
        && m.count + drag.indices.length > MAX_DECORATIONS_PER_MODEL) {
      row.classList.add('drop-full');
      row.title = t('err.moveLimit', {
        max: MAX_DECORATIONS_PER_MODEL,
        total: m.count + drag.indices.length,
        name: m.name,
      });
    }
  });
}

function onDragOver(i, tr, e) {
  if (!drag.indices) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const rect = tr.getBoundingClientRect();
  const before = e.clientY < rect.top + rect.height / 2;
  if (drag.marked && (drag.marked.tr !== tr || drag.marked.before !== before)) clearDropMarker();
  if (!drag.marked) {
    tr.classList.add(before ? 'drop-before' : 'drop-after');
    drag.marked = { tr, before };
    drag.target = { index: i, before };
  }
  // auto-scroll the table while dragging near its edges
  const wrap = els.tableWrap.getBoundingClientRect();
  if (e.clientY < wrap.top + 36) els.tableWrap.scrollTop -= 12;
  else if (e.clientY > wrap.bottom - 36) els.tableWrap.scrollTop += 12;
}

function clearDropMarker() {
  if (drag.marked) {
    drag.marked.tr.classList.remove('drop-before', 'drop-after');
    drag.marked = null;
  }
}

function onDrop(e) {
  e.preventDefault();
  if (!drag.indices || !drag.target) return;
  // insertion point in the current list, then re-expressed with the moved
  // rows lifted out (the engine's coordinate system)
  const raw = drag.target.index + (drag.target.before ? 0 : 1);
  const at = raw - drag.indices.filter((i) => i < raw).length;
  if (state.mode === 'gil') applyGilMove(drag.indices, at);
  else applyMove(drag.indices, at);
  endDrag();
}

function endDrag() {
  clearDropMarker();
  if (drag.indices) for (const idx of drag.indices) state.rows[idx]?.classList.remove('dragging');
  drag.indices = null;
  drag.target = null;
  els.modelList.classList.remove('dec-drag');
  for (const el of els.modelList.querySelectorAll('.drop-target, .drop-invalid, .drop-full')) {
    el.classList.remove('drop-target', 'drop-invalid', 'drop-full');
    el.removeAttribute('title');
  }
}

function applyMove(indices, at) {
  try {
    const res = state.session.moveDecorations(state.currentModel, indices, at);
    if (!res) return;
    // keep the moved block selected at its new position
    state.sel = new Set(Array.from({ length: res.count }, (_, k) => res.start + k));
    state.anchor = res.start;
    if (res.changed) {
      renderDetail();
      renderExport();
    } else {
      syncSelection();
    }
  } catch (err) {
    console.error(err);
    toast(errMsg(err, 'err.splitFail'));
  }
}

function moveSelection(delta) {
  const sel = [...state.sel].sort((a, b) => a - b);
  if (!sel.length) return;
  // block position among the non-selected rows, then shifted by one step
  let k = 0;
  for (let i = 0; i < sel[0]; i++) if (!state.sel.has(i)) k++;
  applyMove(sel, k + delta);
}

els.btnMoveUp.addEventListener('click', () => moveSelection(-1));
els.btnMoveDown.addEventListener('click', () => moveSelection(1));

// ---------- 3D viewer ----------

function ensureViewer() {
  if (state.viewer) return;
  state.viewer = new DecorationViewer(els.vViewport, {
    onSelect: (indices, mode) => {
      if (state.mode === 'gil') return gilViewerSelect(indices, mode);
      let next;
      if (mode === 'replace') next = new Set(indices);
      else {
        next = new Set(state.sel);
        if (mode === 'add') indices.forEach((i) => next.add(i));
        else if (mode === 'subtract') indices.forEach((i) => next.delete(i));
        else indices.forEach((i) => (next.has(i) ? next.delete(i) : next.add(i)));
      }
      state.sel = next;
      state.anchor = indices.length ? indices[0] : null;
      syncSelection();
      if (indices.length === 1) {
        state.rows[indices[0]]?.scrollIntoView({ block: 'nearest' });
      }
    },
  });
}

// Point indices currently selected, for the viewer tools: row indices in
// .gia mode, the focused parent's selected decorations in .gil mode.
function viewerSelIndices() {
  if (state.mode !== 'gil') return state.sel;
  const g = state.gil;
  const out = new Set();
  g.pointIds.forEach((id, i) => { if (g.decoSel.has(id)) out.add(i); });
  return out;
}

function updateViewerStats() {
  const gil = state.mode === 'gil';
  const pts = gil
    ? state.gil.session.decorationPoints(state.gil.viewerParent ?? -1)
    : giaViewerPoints();
  const sel = viewerSelIndices();
  const n = sel.size;
  els.vStats.textContent = `${num(n)} / ${num(pts.length)}`;
  if (n === 0) {
    els.vCoords.textContent = '';
    return;
  }
  // coordinate readout: single point exact, multi-point centroid (raw game
  // world coordinates, before the display mirror)
  let x = 0, y = 0, z = 0;
  for (const i of sel) { x += pts[i].x; y += pts[i].y; z += pts[i].z; }
  const f = (v) => num(v / n, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  els.vCoords.textContent = `(${f(x)}, ${f(y)}, ${f(z)})`;
}

els.vSearch.addEventListener('input', applySearch);
els.vFrameSel.addEventListener('click', () => state.viewer?.frameSelected(viewerSelIndices()));
els.vFrameAll.addEventListener('click', () => state.viewer?.frameAll());
els.vGrid.addEventListener('click', () => els.vGrid.classList.toggle('on', state.viewer?.toggleGrid()));
els.vAxes.addEventListener('click', () => els.vAxes.classList.toggle('on', state.viewer?.toggleAxes()));
els.vLabels.addEventListener('change', () => state.viewer?.setLabels(els.vLabels.value));
els.vSize.addEventListener('input', () => state.viewer?.setPointSize(Number(els.vSize.value)));
els.vColorSel.addEventListener('input', () => state.viewer?.setColors(els.vColorSel.value, null));
els.vColorUnsel.addEventListener('input', () => state.viewer?.setColors(null, els.vColorUnsel.value));
els.vHideSel.addEventListener('click', () => state.viewer?.hideSelected(viewerSelIndices()));
els.vHideUnsel.addEventListener('click', () => state.viewer?.hideUnselected(viewerSelIndices()));
els.vIsolate.addEventListener('click', () => state.viewer?.isolate(viewerSelIndices()));
els.vShowAll.addEventListener('click', () => state.viewer?.showAll());
for (const btn of document.querySelectorAll('.quickview [data-view]')) {
  btn.addEventListener('click', () => state.viewer?.quickView(btn.dataset.view));
}

// ---------- mass rename (undoable) ----------

function commitRenameOp(indices, name) {
  const op = state.session.renameDecorationsBulk(state.currentModel, indices, name);
  if (!op) return;
  state.history.undo.push(op);
  state.history.redo = [];
  renderDetail();
  renderExport();
  toast(tn('toast.renamed', op.changes.length), true);
}

els.btnRenameSel.addEventListener('click', (e) => {
  e.stopPropagation();
  const n = state.mode === 'gil' ? state.gil.decoSel.size : state.sel.size;
  if (!n) return;
  els.renamePop.classList.remove('hidden');
  els.renamePopInput.placeholder = t('rename.placeholder', { n: num(n) });
  els.renamePopInput.value = '';
  els.renamePopInput.focus();
});

function closeRenamePop() { els.renamePop.classList.add('hidden'); }
els.renamePopInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') {
    const v = els.renamePopInput.value.trim();
    closeRenamePop();
    if (!v) return;
    if (state.mode === 'gil') commitGilRename([...state.gil.decoSel], v);
    else commitRenameOp([...state.sel], v);
  } else if (e.key === 'Escape') {
    closeRenamePop();
  }
});
els.renamePop.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', closeRenamePop);

document.addEventListener('keydown', (e) => {
  if (!state.session && !state.gil.session) return;
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) {
    e.preventDefault();
    if (state.mode === 'gil') return doGilUndo();
    const op = state.history.undo.pop();
    if (!op) return;
    state.session.revertRename(op);
    state.history.redo.push(op);
    renderDetail();
    renderExport();
    toast(t('toast.undone'), true);
  } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
    e.preventDefault();
    if (state.mode === 'gil') return doGilRedo();
    const op = state.history.redo.pop();
    if (!op) return;
    state.session.replayRename(op);
    state.history.undo.push(op);
    renderDetail();
    renderExport();
    toast(t('toast.redone'), true);
  }
});

// Clipboard paste: load a .gia/.gil file copied from the OS (Ctrl+V / Cmd+V).
document.addEventListener('paste', (e) => {
  const files = e.clipboardData ? [...e.clipboardData.files] : [];
  const f = files.find((x) => /\.(gia|gil)$/i.test(x.name)) ?? files[0];
  if (!f) return;
  e.preventDefault();
  loadFile(f);
});

// ---------- inline renaming (double-click) ----------

function startInlineRename(el, current, onCommit) {
  if (el.querySelector('input')) return;
  // freeze the host's box first, so swapping text for an input cannot
  // reflow the table/list layout while editing
  const rect = el.getBoundingClientRect();
  el.style.width = `${rect.width}px`;
  el.style.maxWidth = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.value = current;
  input.spellcheck = false;
  el.textContent = '';
  el.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (commit && v && v !== current) onCommit(v);
    else renderAll(); // restore the original display
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
}

function renameModelInline(el, modelId) {
  const m = state.session.models[modelId];
  startInlineRename(el, m.name, (v) => {
    state.session.renameModel(modelId, v);
    renderAll();
  });
}

// ---------- moving decorations to another model (drag onto model row) ----------

function moveSelectionToModel(targetId) {
  const indices = drag.indices ?? [...state.sel];
  if (!indices.length || targetId === state.currentModel) return;
  if (state.session.models[targetId]?.isGroup) return; // groups hold no Decoration list
  try {
    const res = state.session.moveDecorationsToModel(state.currentModel, indices, targetId);
    if (!res) return;
    state.sel = new Set();
    state.anchor = null;
    renderAll();
    toast(tn('toast.moved', res.count, { name: res.targetName }), true);
  } catch (err) {
    console.error(err);
    toast(errMsg(err, 'err.splitFail'));
  }
}

// ---------- split ----------

els.btnSplit.addEventListener('click', () => {
  if (!state.sel.size) return;
  try {
    const n = state.sel.size;
    const newId = state.session.splitModel(state.currentModel, [...state.sel]);
    const newModel = state.session.models[newId];
    state.exportSel.add(newModel.uid); // new models default to exported
    state.sel = new Set();
    state.anchor = null;
    renderModels(newId);
    renderDetail();
    renderExport();
    toast(tn('toast.moved', n, { name: newModel.name }), true);
  } catch (err) {
    console.error(err);
    toast(errMsg(err, 'err.splitFail'));
  }
});

// ---------- ungroup (entity groups) ----------

// Move member entities out of the viewed entity group. `all` takes every
// member (and removes the group); otherwise the selected rows leave and the
// group stays with the rest. Freed members appear as models right after
// the group and default to exported.
function doUngroup(all) {
  const model = state.session.models[state.currentModel];
  if (!model?.isGroup) return;
  const members = state.session.groupMembers(state.currentModel);
  const guids = all ? null : members.filter((x) => state.sel.has(x.index)).map((x) => x.guid);
  if (!all && !guids.length) return;
  try {
    const res = state.session.ungroup(state.currentModel, guids);
    const models = state.session.models;
    for (const id of res.newIds) state.exportSel.add(models[id].uid);
    if (res.removedGroup) {
      state.exportSel.delete(model.uid);
      state.selByModel.delete(model.uid);
      state.currentModel = res.newIds[0] ?? 0; // the group is gone, so show its first member
    }
    state.sel = new Set();
    state.anchor = null;
    state.viewerModel = -1;
    renderModels(res.newIds);
    renderDetail();
    renderExport();
    toast(tn('toast.ungrouped', res.count, { name: model.name }), true);
  } catch (err) {
    console.error(err);
    toast(errMsg(err, 'err.ungroupFail'));
  }
}
els.btnUngroupSel.addEventListener('click', () => doUngroup(false));
els.btnUngroupAll.addEventListener('click', () => doUngroup(true));

// ---------- export ----------

function renderExport() {
  if (state.mode === 'gil') return renderGilExport();
  const s = state.session;
  const models = s.models;
  // drop uids that no longer exist (e.g. after Reset created a new session)
  state.exportSel = new Set([...state.exportSel].filter((uid) => models.some((m) => m.uid === uid)));

  const now = models.length;
  const nSel = state.exportSel.size;
  const partial = nSel < now;


  els.exModels.innerHTML = s.changed
    ? `${num(s.meta.modelsBefore)}<span class="arrow">→</span>${num(now)}`
    : num(now);
  els.exSplits.textContent = num(s.splitCount + s.ungroupCount);
  els.exSelected.textContent = `${num(nSel)}/${num(now)}`;
  els.exSelected.classList.toggle('partial', partial);

  const totalEntries = models
    .filter((m) => state.exportSel.has(m.uid))
    .reduce((sum, m) => sum + m.count, 0);
  els.exportCount.textContent = nSel === 0
    ? t('models.nothing')
    : t('models.exported', { sel: num(nSel), total: num(now), entries: num(totalEntries) });
  els.exportCount.classList.toggle('warn', nSel === 0);

  if (nSel === 0) {
    els.exSize.textContent = '-';
    els.btnDownload.disabled = true;
    els.btnDownload.textContent = t('export.download');
  } else {
    els.exSize.textContent = fmtBytes(s.serialize([...state.exportSel]).length);
    els.btnDownload.disabled = false;
    els.btnDownload.textContent = s.changed || partial
      ? t('export.downloadSplit')
      : t('export.downloadUnchanged');
  }
  els.btnReset.disabled = !s.changed;
}

els.btnReset.addEventListener('click', () => {
  if (state.mode === 'gil') {
    if (!state.gil.session?.changed) return;
    startGilSession(new GilSession(state.sourceBytes));
    toast(t('toast.discarded'), true);
    return;
  }
  if (!state.session?.changed) return;
  startSession(new GiaSession(state.sourceBytes));
  toast(t('toast.discarded'), true);
});

// shared download plumbing: bytes → named file in the user's downloads
function downloadBytes(bytes, name) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

const sanitizeName = (s) => s.replace(/[\\/:*?"<>|]/g, '_');

els.btnDownload.addEventListener('click', () => {
  if (state.mode === 'gil') {
    const s = state.gil.session;
    if (!s) return;
    const fallback = t('export.defaultName', { base: state.fileName });
    const name = sanitizeName(els.setName.value.trim() || fallback);
    try {
      downloadBytes(s.serialize(), `${name}.gil`);
      toast(t('toast.downloaded'), true);
    } catch (err) {
      console.error(err);
      showError(`<p>${escapeHtml(t('gil.serializeFail'))}</p><p class="e">${escapeHtml(err.message)}</p>`);
    }
    return;
  }
  if (!state.session || state.exportSel.size === 0) return;
  const fallback = t('export.defaultName', { base: state.fileName });
  const name = sanitizeName(els.setName.value.trim() || fallback);
  downloadBytes(state.session.serialize([...state.exportSel]), `${name}.gia`);
  toast(t('toast.downloaded'), true);
});

// ================= .gil mode =================
// The same three panels, adapted: the master list shows parent objects
// (checkbox = extraction target, click = focus), the table shows the focused
// parent's attached decorations (click toggles; selection is decoration-id
// based and persists across parents while the parent stays checked), and the
// ops bar offers the two extraction operations plus options and undo/redo.

const WARNING_DISPLAY_CAP = 30;   // dialog rows before "…and {n} more"
const PROGRESS_THRESHOLD = 400;   // decorations; smaller ops finish instantly
const GIL_ROW_HEIGHT = 36;        // fixed .mode-gil .model-row height (virtual list)
const VIRTUAL_THRESHOLD = 400;    // rows before the object list windows itself

function formatGilIssue(issue, kind) {
  return t(`gil.${kind === 'error' ? 'e' : 'w'}.${issue.code}`, issue.params);
}

// The decoration table shows the focused parent (viewing is independent of
// the parent CHECKBOX selection), falling back to the most recently checked
// parent, else nothing.
function effectiveGilParent() {
  const g = state.gil;
  if (!g.session) return null;
  const L = g.session.level;
  if (g.active !== null) {
    const o = L.objectById(g.active);
    if (o && o.decorationIds.length) return o;
  }
  if (g.parentSel.size) return L.objectById([...g.parentSel].pop()) ?? null;
  return null;
}

// Decoration selection is INDEPENDENT of parent selection: switching or
// unchecking parents never discards it. Only selections that stopped
// existing are dropped: parents removed/emptied by an operation, and
// decorations that were extracted (or vanished through undo/redo).
function pruneGilSelection() {
  const g = state.gil;
  const L = g.session.level;
  for (const id of [...g.parentSel]) {
    const o = L.objectById(id);
    if (!o || !o.decorationIds.length) g.parentSel.delete(id);
  }
  if (g.decoSel.size) {
    const existing = new Set(L.decorations.map((d) => d.id));
    for (const did of [...g.decoSel]) if (!existing.has(did)) g.decoSel.delete(did);
  }
}

// Parents that hold at least one selected decoration (for the summary line
// and the sidebar indicator dots). Matched against the parents' decoration
// lists (the authoritative link), not the decorations' back-references.
function gilParentsWithSelection() {
  const g = state.gil;
  const out = new Set();
  if (!g.decoSel.size) return out;
  for (const o of g.session.level.objects) {
    if (o.decorationIds.length && o.decorationIds.some((d) => g.decoSel.has(d))) out.add(o.id);
  }
  return out;
}

// ---------- object list (master) ----------

function visibleGilObjects() {
  const g = state.gil;
  if (!g.session) return [];
  let rows = g.session.objects({ parentsOnly: !g.showAll });
  const q = g.search.trim().toLowerCase();
  if (q) {
    rows = rows.filter(
      (o) =>
        (o.name || '').toLowerCase().includes(q) ||
        String(o.id).includes(q) ||
        String(o.prefabId).includes(q)
    );
  }
  const dir = g.sortAsc ? 1 : -1;
  const key = g.sortKey;
  rows.sort((a, b) => {
    let r = 0;
    if (key === 'name') r = (a.name || '').localeCompare(b.name || '');
    else if (key === 'id') r = (a.id || 0) - (b.id || 0);
    else if (key === 'prefab') r = (a.prefabId || 0) - (b.prefabId || 0);
    else r = a.count - b.count;
    if (r === 0) r = (a.id || 0) - (b.id || 0);
    return r * dir;
  });
  return rows;
}

function makeGilObjRow(o) {
  const g = state.gil;
  const row = document.createElement('div');
  row.className = 'model-row'
    + (o.eligible ? '' : ' no-deco')
    + (g.parentSel.has(o.id) ? ' checked' : '')
    + (o.id === g.active ? ' active' : '');
  row.dataset.objId = o.id;

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'model-export';
  cb.checked = g.parentSel.has(o.id);
  cb.disabled = !o.eligible;

  const name = document.createElement('span');
  name.className = 'model-name';
  name.textContent = o.name || t('model.unnamed');
  name.title = `${o.name ?? ''} · ${o.prefabId ?? ''}`;

  const badges = document.createElement('span');
  badges.className = 'model-badges';
  const oid = document.createElement('span');
  oid.className = 'model-id';
  oid.textContent = o.id ?? '?';
  const count = document.createElement('span');
  count.className = 'model-count';
  count.textContent = num(o.count);
  count.title = tn('model.countTip', o.count);
  badges.append(oid, count);
  if (gilRenderCtx.selParents.has(o.id)) {
    const dot = document.createElement('span');
    dot.className = 'sel-dot';
    dot.title = t('gil.sum.decosSel', {
      n: num(state.gil.decoSel.size),
      k: num(gilRenderCtx.selParents.size),
    });
    badges.appendChild(dot);
  }

  row.append(cb, name, badges);

  // decoration drops: any OTHER world object accepts the dragged rows (the
  // move appends at the end of its list); over-limit targets show as invalid.
  // markGilDropTarget also runs here so virtual-list redraws mid-drag keep
  // the dimmed state.
  if (drag.indices && state.mode === 'gil') markGilDropTarget(row, o.id);
  row.addEventListener('dragover', (e) => {
    if (!drag.indices || o.id === effectiveGilParent()?.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = g.session.level.objectById(o.id);
    const overflow = target
      && target.decorationIds.length + drag.indices.length > MAX_DECORATIONS_PER_PARENT;
    row.classList.add(overflow ? 'drop-invalid' : 'drop-target');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-target', 'drop-invalid'));
  row.addEventListener('drop', (e) => {
    if (!drag.indices || o.id === effectiveGilParent()?.id) return;
    e.preventDefault();
    e.stopPropagation();
    const indices = drag.indices;
    endDrag();
    applyGilMoveToParent(indices, o.id);
  });

  if (o.eligible) {
    row.addEventListener('click', (e) => {
      if (e.target !== cb) onGilParentClick(o.id, e);
    });
    // the checkbox always plain-toggles, whatever the modifier keys
    cb.addEventListener('change', () => {
      if (g.parentSel.has(o.id)) g.parentSel.delete(o.id);
      else g.parentSel.add(o.id);
      g.parentAnchor = o.id;
      g.active = o.id;
      renderGilModels();
      renderGilDetail();
      renderGilOps();
    });
  }
  return row;
}

// Explorer-style selection in the object list: click selects one, Ctrl+click
// toggles, Shift+click ranges over the list's CURRENT visible order (data-
// driven, so it works across the virtualized window). Mirrors the .gia
// decoration table's semantics, including plain-click clearing a lone
// selected row.
function onGilParentClick(id, e) {
  const g = state.gil;
  if (e.shiftKey && g.parentAnchor !== null) {
    const order = visibleGilObjects().filter((o) => o.eligible).map((o) => o.id);
    const a = order.indexOf(g.parentAnchor);
    const b = order.indexOf(id);
    if (a !== -1 && b !== -1) {
      const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
      if (e.ctrlKey || e.metaKey) range.forEach((x) => g.parentSel.add(x));
      else g.parentSel = new Set(range);
    }
  } else if (e.ctrlKey || e.metaKey) {
    if (g.parentSel.has(id)) g.parentSel.delete(id);
    else g.parentSel.add(id);
  } else {
    if (g.parentSel.size === 1 && g.parentSel.has(id)) g.parentSel.clear();
    else g.parentSel = new Set([id]);
  }
  if (!e.shiftKey) g.parentAnchor = id;
  g.active = id;
  renderGilModels();
  renderGilDetail();
  renderGilOps();
}

// Long object lists ("show all" on big levels) render as a virtual window;
// short lists render fully. Row height is fixed by CSS in .gil mode.
function renderGilRows(container, rows) {
  container.textContent = '';
  container.onscroll = null;
  if (rows.length <= VIRTUAL_THRESHOLD) {
    const frag = document.createDocumentFragment();
    for (const r of rows) frag.appendChild(makeGilObjRow(r));
    container.appendChild(frag);
    return;
  }
  const pad = 8; // rows of overscan
  const draw = () => {
    const top = container.scrollTop;
    const h = container.clientHeight;
    const first = Math.max(0, Math.floor(top / GIL_ROW_HEIGHT) - pad);
    const last = Math.min(rows.length, Math.ceil((top + h) / GIL_ROW_HEIGHT) + pad);
    container.textContent = '';
    const spacerTop = document.createElement('div');
    spacerTop.style.height = `${first * GIL_ROW_HEIGHT}px`;
    container.appendChild(spacerTop);
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) frag.appendChild(makeGilObjRow(rows[i]));
    container.appendChild(frag);
    const spacerBottom = document.createElement('div');
    spacerBottom.style.height = `${(rows.length - last) * GIL_ROW_HEIGHT}px`;
    container.appendChild(spacerBottom);
  };
  let raf = 0;
  container.onscroll = () => {
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); });
  };
  draw();
}

// Per-render context for makeGilObjRow (also used by the virtual list's
// scroll redraws): which parents currently hold selected decorations.
const gilRenderCtx = { selParents: new Set() };

function renderGilModels() {
  const g = state.gil;
  gilRenderCtx.selParents = gilParentsWithSelection();
  const rows = visibleGilObjects();
  els.modelCount.textContent = num(rows.length);
  if (!rows.length) {
    els.modelList.textContent = '';
    els.modelList.onscroll = null;
    const msg = document.createElement('div');
    msg.className = 'list-msg';
    if (g.session.parentCount()) {
      msg.textContent = t('gil.empty.filter');
    } else {
      msg.append(t('gil.empty.noParents'), document.createElement('br'));
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = t('gil.empty.noParentsSub');
      msg.appendChild(sub);
    }
    els.modelList.appendChild(msg);
    return;
  }
  renderGilRows(els.modelList, rows);
}

// ---------- decoration table (detail) ----------

function renderGilDetail() {
  const g = state.gil;
  const parent = effectiveGilParent();

  els.detailName.ondblclick = null;
  els.detailName.title = '';
  els.decBody.textContent = '';
  state.rows = [];

  if (!parent) {
    els.detailName.textContent = t('gil.deco.placeholder');
    els.detailCount.textContent = '';
    updateGilViewerData(null);
    syncGilSelection();
    return;
  }

  if (parent.id !== g.viewerParent) g.decoAnchor = null; // ranges never span a parent switch

  els.detailName.textContent = parent.name || t('model.unnamed');
  let rows = g.session.decorations(parent.id);
  els.detailCount.textContent = tn('detail.entries', rows.length);

  if (g.decoSort) {
    const dir = g.decoSortAsc ? 1 : -1;
    const key = g.decoSort;
    rows = rows.slice().sort((a, b) => {
      let r = 0;
      if (key === 'name') r = (a.name || '').localeCompare(b.name || '');
      else if (key === 'prefab') r = (a.prefabId || 0) - (b.prefabId || 0);
      else if (key === 'coll') r = (a.collision ? 1 : 0) - (b.collision ? 1 : 0);
      else r = (a.id || 0) - (b.id || 0);
      if (r === 0) r = (a.id || 0) - (b.id || 0);
      return r * dir;
    });
  }
  syncGilSortHeaders();

  // drag-reordering only makes sense while the table shows file order; a
  // sorted view hides the handles and disables dragging
  const canDrag = g.decoSort === null;
  const frag = document.createDocumentFragment();
  for (const d of rows) {
    const tr = document.createElement('tr');
    tr.dataset.index = d.index; // viewer point index (file order)
    tr.dataset.decoId = d.id;
    tr.draggable = canDrag;
    tr.addEventListener('dragstart', (e) => onDragStart(d.index, e));
    tr.addEventListener('dragover', (e) => onDragOver(d.index, tr, e));
    tr.addEventListener('drop', (e) => onDrop(e));
    tr.addEventListener('dragend', endDrag);

    const tdDrag = document.createElement('td');
    tdDrag.className = 'col-drag';
    if (canDrag) {
      const handle = document.createElement('span');
      handle.className = 'drag-handle';
      handle.textContent = '⠿';
      handle.title = t('reorder.dragTip');
      tdDrag.appendChild(handle);
    }

    const tdCheck = document.createElement('td');
    tdCheck.className = 'col-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.tabIndex = -1;
    cb.addEventListener('click', (e) => { e.stopPropagation(); toggleGilDeco(d.id); });
    tdCheck.appendChild(cb);

    const tdIdx = document.createElement('td');
    tdIdx.className = 'num muted';
    tdIdx.textContent = d.index; // position identifier, never locale-formatted

    const tdName = document.createElement('td');
    tdName.className = 'dec-name';
    if (d.name) tdName.textContent = d.name;
    else { tdName.textContent = '-'; tdName.classList.add('muted'); }
    tdName.title = t('rename.tip');
    tdName.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startInlineRename(tdName, d.name ?? '', (v) => commitGilRename([d.id], v));
    });

    const tdId = document.createElement('td');
    tdId.className = 'num dec-id';
    tdId.textContent = d.id ?? '-';

    const tdPrefab = document.createElement('td');
    tdPrefab.className = 'num dec-id';
    tdPrefab.textContent = d.prefabId ?? '-';
    tdPrefab.title = t('gil.col.prefabTip');

    const tdColl = document.createElement('td');
    tdColl.className = d.collision ? 'coll-on' : 'coll-off';
    tdColl.textContent = d.collision ? t('gil.collision.on') : t('gil.collision.off');

    tr.append(tdDrag, tdCheck, tdIdx, tdName, tdId, tdPrefab, tdColl);
    tr.addEventListener('click', (e) => onGilDecoClick(d.id, e));
    state.rows.push(tr);
    frag.appendChild(tr);
  }
  els.decBody.appendChild(frag);
  updateGilViewerData(parent);
  syncGilSelection();
}

function syncGilSortHeaders() {
  const g = state.gil;
  for (const th of document.querySelectorAll('#dec-table th[data-sort]')) {
    th.classList.toggle('sort-asc', g.decoSort === th.dataset.sort && g.decoSortAsc);
    th.classList.toggle('sort-desc', g.decoSort === th.dataset.sort && !g.decoSortAsc);
  }
}

// checkbox path: always a plain toggle
function toggleGilDeco(id) {
  const g = state.gil;
  if (g.decoSel.has(id)) g.decoSel.delete(id);
  else g.decoSel.add(id);
  g.decoAnchor = id;
  syncGilSelection();
}

// Toggle-based selection, matching the .gia table: a click toggles just
// that row, never resetting the rest of the selection (which may span
// other parent objects), and Shift+click INVERTS every row between the
// anchor and the click over the table's current (possibly sorted) order
// (anchor excluded: its click already toggled it). Toggle on + shift-click
// selects the range; toggle off + shift-click deselects it.
function onGilDecoClick(id, e) {
  const g = state.gil;
  if (e.shiftKey && g.decoAnchor !== null) {
    const order = state.rows.map((tr) => Number(tr.dataset.decoId));
    const a = order.indexOf(g.decoAnchor);
    const b = order.indexOf(id);
    if (a !== -1 && b !== -1) {
      for (const x of order.slice(Math.min(a, b), Math.max(a, b) + 1)) {
        if (x === g.decoAnchor) continue;
        if (g.decoSel.has(x)) g.decoSel.delete(x);
        else g.decoSel.add(x);
      }
    }
    syncGilSelection();
    return;
  }
  toggleGilDeco(id); // plain and Ctrl+click both toggle (sets the anchor)
}

// Reflect the id-based selection into row classes, checkboxes, the viewer,
// the sidebar indicator dots and the ops bar (no rebuild).
function syncGilSelection() {
  const g = state.gil;
  for (const tr of state.rows) {
    const sel = g.decoSel.has(Number(tr.dataset.decoId));
    tr.classList.toggle('selected', sel);
    tr.querySelector('input').checked = sel;
  }
  if (state.viewer) {
    state.viewer.setSelection(viewerSelIndices());
    updateViewerStats();
  }
  updateGilSelDots();
  renderGilOps();
}

// Keep the sidebar's "holds selected decorations" dots current without
// rebuilding the (possibly virtualized) list.
function updateGilSelDots() {
  gilRenderCtx.selParents = gilParentsWithSelection();
  const title = t('gil.sum.decosSel', {
    n: num(state.gil.decoSel.size),
    k: num(gilRenderCtx.selParents.size),
  });
  for (const row of els.modelList.querySelectorAll('.model-row')) {
    const has = gilRenderCtx.selParents.has(Number(row.dataset.objId));
    let dot = row.querySelector('.sel-dot');
    if (has && !dot) {
      dot = document.createElement('span');
      dot.className = 'sel-dot';
      row.querySelector('.model-badges')?.appendChild(dot);
    } else if (!has && dot) {
      dot.remove();
      dot = null;
    }
    if (dot) dot.title = title;
  }
}

// push the focused parent's decoration points into the viewer; the camera
// re-frames only when the viewed parent actually changed
function updateGilViewerData(parent) {
  if (!state.viewer) return;
  const g = state.gil;
  const id = parent ? parent.id : null;
  const frame = g.viewerParent !== id;
  g.viewerParent = id;
  const points = id !== null ? g.session.decorationPoints(id) : [];
  g.pointIds = points.map((p) => p.guid);
  state.viewer.setData(points, { frame });
  applySearch();
}

// viewer picks map through the focused parent's points; 'replace' replaces
// the whole selection, matching the explorer-style click semantics of the
// table (cross-parent selections accumulate via Ctrl / checkboxes)
function gilViewerSelect(indices, mode) {
  const g = state.gil;
  const ids = indices.map((i) => g.pointIds[i]).filter((x) => x !== undefined);
  if (mode === 'replace') {
    g.decoSel = new Set(ids);
  } else if (mode === 'add') {
    ids.forEach((d) => g.decoSel.add(d));
  } else if (mode === 'subtract') {
    ids.forEach((d) => g.decoSel.delete(d));
  } else {
    ids.forEach((d) => (g.decoSel.has(d) ? g.decoSel.delete(d) : g.decoSel.add(d)));
  }
  g.decoAnchor = ids.length ? ids[0] : null;
  syncGilSelection();
  if (indices.length === 1) {
    state.rows.find((tr) => Number(tr.dataset.index) === indices[0])
      ?.scrollIntoView({ block: 'nearest' });
  }
}

// ---------- ops bar (buttons, options, summary) ----------

function renderGilOps() {
  const g = state.gil;
  if (!g.session) return;
  pruneGilSelection();
  const L = g.session.level;
  const parents = [...g.parentSel].map((id) => L.objectById(id)).filter(Boolean);
  const totalDecos = parents.reduce((a, o) => a + o.decorationIds.length, 0);
  const nSel = g.decoSel.size;
  const selParents = gilParentsWithSelection();

  // "Separate Selected" follows the decoration selection alone: it extracts
  // every selected decoration wherever it lives, checked parents or not.
  els.btnGilSplitSel.disabled = nSel === 0;
  els.btnGilSplitSel.title = nSel === 0
    ? t('gil.tip.needDecoSel')
    : t('gil.sum.selDecos', { n: num(nSel) });
  els.btnGilSplitParents.disabled = parents.length === 0;
  els.btnGilSplitParents.title = parents.length === 0
    ? t('gil.tip.needParentSel')
    : t('gil.sum.parents', { n: num(totalDecos), k: num(parents.length) });

  // global selection summary; makes clear that switching the viewed parent
  // never discards selections ("27 decorations selected across 4 parents")
  const lines = [];
  if (parents.length) lines.push(t('gil.sum.parentsSel', { n: num(parents.length) }));
  if (nSel) lines.push(t('gil.sum.decosSel', { n: num(nSel), k: num(selParents.size) }));
  els.gilOpInfo.textContent = lines.join('\n');
  els.gilOpInfo.classList.toggle('armed', lines.length > 0);

  els.btnGilUndo.disabled = !g.session.canUndo;
  els.btnGilRedo.disabled = !g.session.canRedo;
  els.btnRenameSel.disabled = nSel === 0;
}

// ---------- extraction operations ----------

let splitting = false;

// mode 'decos': exactly the decorations selected in the table, wherever they
// live. The selection spans parents and survives viewing/checkbox changes.
// mode 'parents': every decoration of the checked parent objects.
async function doGilSplit(mode) {
  const g = state.gil;
  if (!g.session || splitting) return;
  pruneGilSelection();
  const onlyDecoIds = mode === 'decos' ? new Set(g.decoSel) : null;
  if (mode === 'decos' ? !onlyDecoIds.size : !g.parentSel.size) return;

  const label = mode === 'decos'
    ? { key: 'gil.op.labelSelDecos', params: { n: onlyDecoIds.size } }
    : { key: 'gil.op.label', params: { n: g.parentSel.size } };

  let planned;
  splitting = true;
  try {
    const large = (onlyDecoIds ? onlyDecoIds.size : [...g.parentSel].reduce((a, id) => {
      const o = g.session.level.objectById(id);
      return a + (o ? o.decorationIds.length : 0);
    }, 0)) > PROGRESS_THRESHOLD;
    if (large) {
      showProgress(t('gil.progress.analyzing'));
      await nextPaint();
    }
    try {
      planned = g.session.planExtraction({
        mode,
        selectedParentIds: g.parentSel,
        onlyDecoIds,
        removeParent: g.removeParent,
      });
    } catch (err) {
      console.error(err);
      showError(`<p>${escapeHtml(t('gil.analyzeFail'))}</p><p class="e">${escapeHtml(err.message)}</p>`);
      return;
    }
    const { plan } = planned;
    if (plan.errors.length) {
      showError(
        `<p>${escapeHtml(t('gil.valFailed'))}</p><ul>` +
        plan.errors.slice(0, WARNING_DISPLAY_CAP)
          .map((e) => `<li class="e">${escapeHtml(formatGilIssue(e, 'error'))}</li>`).join('') +
        (plan.errors.length > WARNING_DISPLAY_CAP
          ? `<li class="e">${escapeHtml(t('gil.wMore', { n: plan.errors.length - WARNING_DISPLAY_CAP }))}</li>`
          : '') +
        '</ul>'
      );
      return;
    }
    if (!plan.entries.length) {
      showError(`<p>${escapeHtml(t('gil.noExtractable'))}</p>`);
      return;
    }
  } finally {
    hideProgress();
    splitting = false;
  }

  const { plan, removal } = planned;
  const allWarnings = [...plan.warnings, ...removal.warnings];
  const run = () => runGilSplit(mode, plan, removal, label);

  if (allWarnings.length) {
    // zoom-limit warnings get their own grouped section; everything is
    // non-destructive until the user confirms
    const scaleWs = allWarnings.filter((w) => w.code === 'scaleExceeds');
    const otherWs = allWarnings.filter((w) => w.code !== 'scaleExceeds');
    const listHtml = (ws) => {
      let html = ws.slice(0, WARNING_DISPLAY_CAP)
        .map((w) => `<li class="w">${escapeHtml(formatGilIssue(w, 'warning'))}</li>`).join('');
      if (ws.length > WARNING_DISPLAY_CAP) {
        html += `<li class="w">${escapeHtml(t('gil.wMore', { n: ws.length - WARNING_DISPLAY_CAP }))}</li>`;
      }
      return html;
    };
    let body = `<p>${escapeHtml(t('gil.confirm.intro', {
      count: num(plan.entries.length),
      parents: num(new Set(plan.entries.map((e) => e.parent.id)).size),
    }))}</p>`;
    if (scaleWs.length) {
      body += `<p class="w">${escapeHtml(t('gil.dlg.scaleIntro', { max: MAX_SCALE }))}</p>`
        + `<ul>${listHtml(scaleWs)}</ul>`
        + `<p class="w">${escapeHtml(t('gil.scaleNote'))}</p>`;
    }
    if (otherWs.length) body += `<ul>${listHtml(otherWs)}</ul>`;
    body += `<p>${escapeHtml(t('gil.confirm.outro'))}</p>`;
    confirmDialog(scaleWs.length ? t('gil.dlg.scale') : t('gil.dlg.review'), body, run);
  } else {
    run();
  }
}

async function runGilSplit(mode, plan, removal, label) {
  const g = state.gil;
  if (splitting) return;
  splitting = true;
  try {
    const large = plan.entries.length > PROGRESS_THRESHOLD;
    if (large) {
      showProgress(t('gil.progress.label', { done: 0, total: num(plan.entries.length) }));
      await nextPaint();
    }
    const summary = await g.session.applyExtraction({
      plan,
      removal,
      label,
      collision: g.collision,
      removeParent: g.removeParent,
      onProgress: large ? updateProgress : null,
    });
    g.parentSel.clear();
    g.decoSel.clear();
    toast(
      t(mode === 'decos' ? 'gil.toast.extractedSel' : 'gil.toast.extractedAll', {
        decos: num(summary.removedDecorations),
        parents: num(summary.parents),
      }),
      true
    );
    renderAll();
  } catch (err) {
    console.error(err);
    showError(
      `<p>${escapeHtml(t('gil.opFailed'))}</p><p class="e">${escapeHtml(err.message)}</p>` +
      `<p>${escapeHtml(t('gil.opFailedNote'))}</p>`
    );
  } finally {
    hideProgress();
    splitting = false;
  }
}

// Rename decorations by id (single inline rename and the bulk popover both
// route here). Byte-preserving via the session; lands on the shared undo
// stack, so Ctrl+Z / the Undo button revert it exactly.
function commitGilRename(ids, name) {
  const g = state.gil;
  if (!g.session || !ids.length) return;
  try {
    const res = g.session.renameDecorations(ids, name);
    if (!res) {
      renderAll(); // restore the inline editor's original display
      return;
    }
    toast(tn('toast.renamed', res.changed), true);
    renderAll();
  } catch (err) {
    console.error(err);
    showError(`<p>${escapeHtml(t('gil.opFailed'))}</p><p class="e">${escapeHtml(err.message)}</p>`);
  }
}

// Dim a sidebar row that cannot accept the dragged decorations (would exceed
// the game's per-parent limit); the localized tooltip explains why.
function markGilDropTarget(row, objId) {
  const focus = effectiveGilParent();
  if (!focus || objId === focus.id || !drag.indices) return;
  const target = state.gil.session.level.objectById(objId);
  if (!target) return;
  const total = target.decorationIds.length + drag.indices.length;
  if (total > MAX_DECORATIONS_PER_PARENT) {
    row.classList.add('drop-full');
    row.title = t('gil.err.moveLimit', {
      max: MAX_DECORATIONS_PER_PARENT,
      total,
      name: target.name ?? String(objId),
    });
  }
}

// Move the dragged decorations from the focused parent into another world
// object (appended at the end, back-references rewritten, byte-preserving).
// The id-based selection follows the moved decorations to their new parent.
function applyGilMoveToParent(indices, targetId) {
  const g = state.gil;
  const parent = effectiveGilParent();
  if (!parent || parent.id === targetId) return;
  try {
    const res = g.session.moveDecorationsToParent(parent.id, indices, targetId);
    if (!res) return;
    toast(tn('toast.moved', res.count, { name: res.targetName || t('model.unnamed') }), true);
    renderAll();
  } catch (err) {
    console.error(err);
    toast(errMsg(err, 'err.splitFail'));
  }
}

// Reorder the focused parent's decoration list (byte-preserving; only the
// parent's packed id list is rewritten). The id-based selection follows the
// moved rows automatically, and the operation lands on the shared undo stack.
function applyGilMove(indices, at) {
  const g = state.gil;
  const parent = effectiveGilParent();
  if (!parent) return;
  try {
    const res = g.session.reorderDecorations(parent.id, indices, at);
    if (!res || !res.changed) return;
    renderAll();
  } catch (err) {
    console.error(err);
    showError(`<p>${escapeHtml(t('gil.opFailed'))}</p><p class="e">${escapeHtml(err.message)}</p>`);
  }
}

function doGilUndo() {
  const label = state.gil.session?.undo();
  if (!label) return;
  toast(t('gil.toast.undid', { label: t(label.key, label.params) }), true);
  renderAll();
}

function doGilRedo() {
  const label = state.gil.session?.redo();
  if (!label) return;
  toast(t('gil.toast.redid', { label: t(label.key, label.params) }), true);
  renderAll();
}

// ---------- export bar (.gil) ----------

function renderGilExport() {
  const s = state.gil.session;
  const now = s.level.objects.length;
  els.exModels.innerHTML = s.changed
    ? `${num(s.meta.objectsBefore)}<span class="arrow">→</span>${num(now)}`
    : num(now);
  els.exSplits.textContent = num(s.edits);
  els.exSize.textContent = fmtBytes(s.serialize().length);
  els.btnDownload.disabled = false;
  els.btnDownload.textContent = s.changed
    ? t('gil.export.download')
    : t('gil.export.downloadUnchanged');
  els.btnReset.disabled = !s.changed;
}

// ---------- shared dialogs & progress overlay ----------

function showError(html) {
  els.emBody.innerHTML = html;
  els.errorModal.showModal();
}
els.emClose.addEventListener('click', () => els.errorModal.close());

function confirmDialog(title, html, onOk) {
  els.cmHead.textContent = title;
  els.cmBody.innerHTML = html;
  const done = (accepted) => {
    els.confirmModal.close();
    els.cmOk.onclick = els.cmCancel.onclick = null;
    if (accepted) onOk();
  };
  els.cmOk.onclick = () => done(true);
  els.cmCancel.onclick = () => done(false);
  els.confirmModal.showModal();
}

function showProgress(label) {
  els.progressLabel.textContent = label;
  els.progressBar.style.width = '0%';
  els.progressOverlay.classList.remove('hidden');
}
function updateProgress(done, total) {
  els.progressLabel.textContent = t('gil.progress.label', { done: num(done), total: num(total) });
  els.progressBar.style.width = `${((done / total) * 100).toFixed(1)}%`;
}
function hideProgress() {
  els.progressOverlay.classList.add('hidden');
}
// wait for a paint so the progress overlay is visible before heavy work; the
// timeout fallback keeps operations moving when the tab is hidden (rAF is
// suspended in background tabs)
const nextPaint = () => new Promise((r) => {
  requestAnimationFrame(() => setTimeout(r, 0));
  setTimeout(r, 150);
});

// ---------- .gil control wiring ----------

els.objSearch.addEventListener('input', () => {
  state.gil.search = els.objSearch.value;
  renderGilModels();
});
els.objShowAll.addEventListener('change', () => {
  state.gil.showAll = els.objShowAll.checked;
  renderGilModels();
});
els.objSort.addEventListener('change', () => {
  state.gil.sortKey = els.objSort.value;
  state.gil.sortAsc = els.objSort.value !== 'deco'; // counts default to descending
  renderGilModels();
});

for (const th of document.querySelectorAll('#dec-table th[data-sort]')) {
  th.addEventListener('click', () => {
    if (state.mode !== 'gil') return;
    const g = state.gil;
    const key = th.dataset.sort;
    if (g.decoSort === key) {
      if (g.decoSortAsc) g.decoSortAsc = false;
      else { g.decoSort = null; g.decoSortAsc = true; } // third click: file order
    } else {
      g.decoSort = key;
      g.decoSortAsc = true;
    }
    renderGilDetail();
  });
}

els.btnGilSplitSel.addEventListener('click', () => doGilSplit('decos'));
els.btnGilSplitParents.addEventListener('click', () => doGilSplit('parents'));
els.btnGilUndo.addEventListener('click', doGilUndo);
els.btnGilRedo.addEventListener('click', doGilRedo);

els.gilOptCollision.addEventListener('change', () => {
  state.gil.collision = els.gilOptCollision.checked;
  savePref(COLLISION_PREF_KEY, state.gil.collision);
});
els.gilOptRemoveParent.addEventListener('change', () => {
  state.gil.removeParent = els.gilOptRemoveParent.checked;
  savePref(REMOVE_PARENT_PREF_KEY, state.gil.removeParent);
});

// ---------- resizable panels ----------
// Drag the dividers to resize the object/model list and the 3D viewer (the
// decoration table flexes in between). Widths persist across sessions;
// double-clicking a divider restores that panel's default (CSS-driven) size.

const PANEL_W_KEYS = { models: 'splitter-ui-models-w', viewer: 'splitter-ui-viewer-w' };
function loadNumPref(key) {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch { return null; }
}
function saveNumPref(key, v) {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(Math.round(v)));
  } catch {}
}

function initPanelResize() {
  const panels = {
    models: {
      el: document.getElementById('model-panel'),
      min: 220,
      max: () => window.innerWidth * 0.4,
      apply(w) { this.el.style.width = `${w}px`; this.el.style.minWidth = `${w}px`; },
      clear() { this.el.style.width = ''; this.el.style.minWidth = ''; },
    },
    viewer: {
      el: document.getElementById('viewer-panel'),
      min: 260,
      max: () => window.innerWidth * 0.55,
      // the viewer normally flex-grows; a user-chosen width pins it
      apply(w) { this.el.style.flex = `0 0 ${w}px`; },
      clear() { this.el.style.flex = ''; },
    },
  };
  for (const [name, p] of Object.entries(panels)) {
    const saved = loadNumPref(PANEL_W_KEYS[name]);
    if (saved !== null) p.apply(Math.min(p.max(), Math.max(p.min, saved)));
  }
  for (const split of document.querySelectorAll('.vsplit')) {
    const p = panels[split.dataset.panel];
    if (!p) continue;
    let startX = 0;
    let startW = 0;
    split.addEventListener('pointerdown', (e) => {
      startX = e.clientX;
      startW = p.el.getBoundingClientRect().width;
      split.classList.add('dragging');
      split.setPointerCapture(e.pointerId);
    });
    split.addEventListener('pointermove', (e) => {
      if (!split.classList.contains('dragging')) return;
      // the models divider sits on the panel's right edge, the viewer divider
      // on its left, so dragging outward grows the respective panel
      const delta = split.dataset.panel === 'models' ? e.clientX - startX : startX - e.clientX;
      p.apply(Math.min(p.max(), Math.max(p.min, startW + delta)));
      state.viewer?.resize();
    });
    const end = (e) => {
      if (!split.classList.contains('dragging')) return;
      split.classList.remove('dragging');
      if (split.hasPointerCapture?.(e.pointerId)) split.releasePointerCapture(e.pointerId);
      saveNumPref(PANEL_W_KEYS[split.dataset.panel], p.el.getBoundingClientRect().width);
    };
    split.addEventListener('pointerup', end);
    split.addEventListener('pointercancel', end);
    split.addEventListener('dblclick', () => {
      p.clear();
      saveNumPref(PANEL_W_KEYS[split.dataset.panel], null);
      state.viewer?.resize();
    });
  }
}
initPanelResize();

// ---------- misc ----------

function renderAll() {
  if (state.mode === 'gil') {
    renderMeta(); // object/decoration counts change with every operation
    renderGilModels();
    renderGilDetail(); // calls syncGilSelection → renderGilOps
    renderExport();
    return;
  }
  renderModels();
  renderDetail();
  renderExport();
}

let toastTimer = null;
function toast(msg, ok = false) {
  els.toast.textContent = msg;
  els.toast.className = 'toast' + (ok ? ' ok' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 3500);
}

function fmtBytes(n) {
  if (n < 1024) return `${num(n)} ${t('unit.b')}`;
  if (n < 1024 * 1024) return `${num(n / 1024, { maximumFractionDigits: 1 })} ${t('unit.kb')}`;
  return `${num(n / 1024 / 1024, { maximumFractionDigits: 2 })} ${t('unit.mb')}`;
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

window.__gia = { state }; // debug hook
