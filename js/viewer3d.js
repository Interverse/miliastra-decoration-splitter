// 3D Decoration Viewer: renders every decoration of the selected model as a
// point at its world position (from js/gia-splitter.js decorationPoints()),
// with screen-space picking, box selection, and camera tooling. Pure display
// layer; it never touches the byte-preserving engine.
//
// Mouse map (left button is reserved for selection so it can't fight the
// camera): LEFT click/drag = pick / box select, RIGHT drag = orbit,
// MIDDLE drag = pan, wheel = zoom. Modifiers: Ctrl add, Alt subtract,
// Shift toggle.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// camera directions per quick view, in GAME axes: the display mirrors X, so
// looking from game +X means placing the camera on the display's −X side
const AXIS_VIEWS = {
  home: new THREE.Vector3(1, 0.7, 1).normalize(),
  px: new THREE.Vector3(-1, 0.0001, 0).normalize(),
  nx: new THREE.Vector3(1, 0.0001, 0).normalize(),
  py: new THREE.Vector3(0.0001, 1, 0.0001).normalize(),
  ny: new THREE.Vector3(0.0001, -1, 0.0001).normalize(),
  pz: new THREE.Vector3(0, 0.0001, 1).normalize(),
  nz: new THREE.Vector3(0, 0.0001, -1).normalize(),
};

const LABEL_CAP = 600; // labels drawn per pass (nearest first)

// Grid styling, shared by the initial grid and every _fitHelpers rebuild.
// Tuned to stand out clearly against the near-black background (0x0b0d12)
// while staying below the points and axes in visual weight.
const GRID_CENTER_COLOR = 0x5a6580; // the two center lines (origin cross)
const GRID_LINE_COLOR = 0x3a455c;
const GRID_OPACITY = 0.85;

function makeGrid(size, divisions) {
  const grid = new THREE.GridHelper(size, divisions, GRID_CENTER_COLOR, GRID_LINE_COLOR);
  grid.material.transparent = true;
  grid.material.opacity = GRID_OPACITY;
  return grid;
}

function circleSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.beginPath();
  ctx.arc(32, 32, 28, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class DecorationViewer {
  constructor(container, { onSelect } = {}) {
    this.container = container;
    this.onSelect = onSelect;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.autoClear = false;
    container.appendChild(this.renderer.domElement);

    this.labelCanvas = document.createElement('canvas');
    this.labelCanvas.className = 'viewer-labels';
    container.appendChild(this.labelCanvas);

    this.band = document.createElement('div');
    this.band.className = 'rubber-band hidden';
    container.appendChild(this.band);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0d12);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.01, 2000);
    this.camera.position.set(4, 3, 4);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.mouseButtons = { LEFT: -1, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.addEventListener('change', () => { this.labelsDirty = true; });

    this.grid = makeGrid(10, 10);
    this.scene.add(this.grid);
    // the scene displays game coordinates with X mirrored, so every axis
    // indicator flips its X arm to point toward game +X (display −X);
    // Y and Z are unaffected
    this.axes = new THREE.AxesHelper(2);
    this.axes.scale.x = -1;
    this.scene.add(this.axes);

    // orientation gizmo (corner inset)
    this.gizmoScene = new THREE.Scene();
    const gizmoAxes = new THREE.AxesHelper(1);
    gizmoAxes.scale.x = -1; // match the mirrored display (game +X)
    this.gizmoScene.add(gizmoAxes);
    for (const [txt, color, pos] of [
      ['X', '#ff5f5f', [-1.35, 0, 0]], ['Y', '#5fdd5f', [0, 1.35, 0]], ['Z', '#5f9fff', [0, 0, 1.35]],
    ]) {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const ctx = c.getContext('2d');
      ctx.font = 'bold 44px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = color;
      ctx.fillText(txt, 32, 34);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
      sprite.position.set(...pos);
      sprite.scale.setScalar(0.55);
      this.gizmoScene.add(sprite);
    }
    this.gizmoCam = new THREE.PerspectiveCamera(45, 1, 0.1, 10);

    // point cloud state
    this.data = [];              // [{index,guid,name,x,y,z}] engine order
    this.displayPos = null;      // Float32Array, mirrored for display
    this.visIdx = [];            // geometry slot -> data index
    this.hidden = new Set();     // data indices currently hidden
    this.selection = new Set();  // data indices selected
    this.searchHits = new Set(); // data indices matching the search
    this.searchQuery = '';
    this.pointSize = 7;
    this.selColor = new THREE.Color('#39d0d8').convertSRGBToLinear();
    this.unselColor = new THREE.Color('#7d879c').convertSRGBToLinear();
    this.searchColor = new THREE.Color('#ffd257').convertSRGBToLinear();
    this.labelMode = 'off';      // 'off' | 'name' | 'index'
    this.labelsDirty = true;

    this.points = null;
    this.material = new THREE.PointsMaterial({
      size: this.pointSize,
      sizeAttenuation: false,
      vertexColors: true,
      map: circleSprite(),
      alphaTest: 0.5,
    });

    this._bindSelectionEvents();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();

    const loop = () => {
      requestAnimationFrame(loop);
      this.controls.update();
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      this._renderGizmo();
      if (this.labelsDirty) { this._drawLabels(); this.labelsDirty = false; }
    };
    loop();
  }

  // ---------- data ----------

  // frame: reset the camera to fit (used when switching models); plain data
  // refreshes (rename, reorder, …) keep the current camera untouched
  setData(points, { frame = true } = {}) {
    this.data = points;
    this.displayPos = new Float32Array(points.length * 3);
    for (let i = 0; i < points.length; i++) {
      // display mirrors X so the scene matches the in-game view; the axis
      // indicators are X-flipped to match (see gizmo/axes setup), and all
      // readouts/exports use the raw unmirrored coordinates
      this.displayPos[i * 3] = -points[i].x;
      this.displayPos[i * 3 + 1] = points[i].y;
      this.displayPos[i * 3 + 2] = points[i].z;
    }
    this.hidden = new Set();
    this._recomputeSearch();
    this._rebuildGeometry();
    this._fitHelpers();
    if (frame) this.frameAll();
  }

  setSelection(sel) {
    this.selection = new Set(sel);
    this._refreshColors();
    this.labelsDirty = true;
  }

  setSearch(query) {
    this.searchQuery = (query ?? '').trim().toLowerCase();
    this._recomputeSearch();
    this._refreshColors();
    this.labelsDirty = true;
    return this.searchHits;
  }

  _recomputeSearch() {
    this.searchHits = new Set();
    if (!this.searchQuery) return;
    for (const p of this.data) {
      if ((p.name ?? '').toLowerCase().includes(this.searchQuery)
          || String(p.index) === this.searchQuery) {
        this.searchHits.add(p.index);
      }
    }
  }

  // ---------- appearance ----------

  setPointSize(px) {
    this.pointSize = px;
    this.material.size = px;
  }

  setColors(selHex, unselHex) {
    if (selHex) this.selColor = new THREE.Color(selHex).convertSRGBToLinear();
    if (unselHex) this.unselColor = new THREE.Color(unselHex).convertSRGBToLinear();
    this._refreshColors();
  }

  setLabels(mode) {
    this.labelMode = mode;
    this.labelsDirty = true;
  }

  toggleGrid() { this.grid.visible = !this.grid.visible; return this.grid.visible; }
  toggleAxes() { this.axes.visible = !this.axes.visible; return this.axes.visible; }

  // ---------- visibility ----------

  hideSelected(sel) { for (const i of sel) this.hidden.add(i); this._rebuildGeometry(); }
  hideUnselected(sel) {
    for (const p of this.data) if (!sel.has(p.index)) this.hidden.add(p.index);
    this._rebuildGeometry();
  }
  isolate(sel) {
    this.hidden = new Set(this.data.filter((p) => !sel.has(p.index)).map((p) => p.index));
    this._rebuildGeometry();
  }
  showAll() { this.hidden = new Set(); this._rebuildGeometry(); }
  hiddenCount() { return this.hidden.size; }

  // ---------- camera ----------

  frameAll() { this._frame(this.visIdx.map((i) => i)); }
  frameSelected(sel) {
    const idx = [...(sel ?? this.selection)].filter((i) => !this.hidden.has(i));
    this._frame(idx.length ? idx : this.visIdx);
  }

  _frame(indices) {
    if (!indices.length || !this.displayPos) return;
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const i of indices) {
      box.expandByPoint(v.set(this.displayPos[i * 3], this.displayPos[i * 3 + 1], this.displayPos[i * 3 + 2]));
    }
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.25);
    const dist = radius / Math.tan((this.camera.fov * Math.PI / 180) / 2) * 1.15 + radius * 0.2;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (!Number.isFinite(dir.x) || dir.lengthSq() < 1e-6) dir.copy(AXIS_VIEWS.home);
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.near = Math.max(dist / 1000, 0.001);
    this.camera.far = dist * 100 + radius * 10;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.labelsDirty = true;
  }

  quickView(name) {
    const dir = AXIS_VIEWS[name];
    if (!dir) return;
    const dist = this.camera.position.distanceTo(this.controls.target);
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
    this.controls.update();
    this.labelsDirty = true;
  }

  // ---------- internals ----------

  _fitHelpers() {
    if (!this.data.length) return;
    let maxR = 0.5;
    for (let i = 0; i < this.data.length; i++) {
      maxR = Math.max(maxR, Math.abs(this.displayPos[i * 3]), Math.abs(this.displayPos[i * 3 + 2]));
    }
    this.scene.remove(this.grid);
    const size = Math.ceil(maxR * 2.4) || 10;
    const wasVisible = this.grid.visible;
    this.grid = makeGrid(size, Math.min(size * 2, 40));
    // the grid stays centered at the world origin (y = 0): its center lines
    // coincide exactly with the axis indicator's X/Z arms, so the axes, grid,
    // and object coordinates all share one origin and orientation
    this.grid.visible = wasVisible;
    this.scene.add(this.grid);
    const axScale = Math.max(size / 8, 0.5);
    this.axes.scale.set(-axScale, axScale, axScale); // keep the game-+X flip
  }

  _rebuildGeometry() {
    this.visIdx = this.data.filter((p) => !this.hidden.has(p.index)).map((p) => p.index);
    const n = this.visIdx.length;
    const pos = new Float32Array(n * 3);
    for (let s = 0; s < n; s++) {
      const i = this.visIdx[s];
      pos[s * 3] = this.displayPos[i * 3];
      pos[s * 3 + 1] = this.displayPos[i * 3 + 1];
      pos[s * 3 + 2] = this.displayPos[i * 3 + 2];
    }
    if (this.points) {
      this.scene.remove(this.points);
      this.points.geometry.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.points = new THREE.Points(geo, this.material);
    this.scene.add(this.points);
    this._refreshColors();
    this.labelsDirty = true;
  }

  _refreshColors() {
    if (!this.points) return;
    const attr = this.points.geometry.getAttribute('color');
    const arr = attr.array;
    for (let s = 0; s < this.visIdx.length; s++) {
      const i = this.visIdx[s];
      const c = this.selection.has(i) ? this.selColor
        : this.searchHits.has(i) ? this.searchColor
        : this.unselColor;
      arr[s * 3] = c.r; arr[s * 3 + 1] = c.g; arr[s * 3 + 2] = c.b;
    }
    attr.needsUpdate = true;
  }

  _project() {
    // screen-space positions of every visible point (null when behind camera)
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return []; // panel hidden (responsive breakpoint)
    const v = new THREE.Vector3();
    const out = new Array(this.visIdx.length);
    for (let s = 0; s < this.visIdx.length; s++) {
      const i = this.visIdx[s];
      v.set(this.displayPos[i * 3], this.displayPos[i * 3 + 1], this.displayPos[i * 3 + 2]).project(this.camera);
      out[s] = v.z > 1 || v.z < -1 ? null
        : { i, x: (v.x + 1) / 2 * w, y: (1 - v.y) / 2 * h, z: v.z };
    }
    return out;
  }

  _mode(e) {
    if (e.ctrlKey || e.metaKey) return 'add';
    if (e.altKey) return 'subtract';
    if (e.shiftKey) return 'toggle';
    return 'replace';
  }

  _bindSelectionEvents() {
    const el = this.renderer.domElement;
    let down = null, boxing = false;

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const r = this.container.getBoundingClientRect();
      down = { x: e.clientX - r.left, y: e.clientY - r.top };
      boxing = false;
    });
    el.addEventListener('pointermove', (e) => {
      if (!down || !(e.buttons & 1)) return;
      const r = this.container.getBoundingClientRect();
      const cur = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (!boxing && Math.hypot(cur.x - down.x, cur.y - down.y) > 4) {
        boxing = true;
        this.band.classList.remove('hidden');
      }
      if (boxing) {
        const x = Math.min(down.x, cur.x), y = Math.min(down.y, cur.y);
        this.band.style.left = `${x}px`;
        this.band.style.top = `${y}px`;
        this.band.style.width = `${Math.abs(cur.x - down.x)}px`;
        this.band.style.height = `${Math.abs(cur.y - down.y)}px`;
      }
    });
    el.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !down) return;
      const r = this.container.getBoundingClientRect();
      const up = { x: e.clientX - r.left, y: e.clientY - r.top };
      const mode = this._mode(e);
      if (boxing) {
        this.band.classList.add('hidden');
        const x0 = Math.min(down.x, up.x), x1 = Math.max(down.x, up.x);
        const y0 = Math.min(down.y, up.y), y1 = Math.max(down.y, up.y);
        const inside = [];
        for (const p of this._project()) {
          if (p && p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) inside.push(p.i);
        }
        this.onSelect?.(inside, mode);
      } else {
        const rad = Math.max(this.pointSize / 2 + 5, 8);
        let best = null, bestD = rad;
        for (const p of this._project()) {
          if (!p) continue;
          const d = Math.hypot(p.x - up.x, p.y - up.y);
          if (d < bestD || (best && Math.abs(d - bestD) < 0.5 && p.z < best.z)) {
            best = p; bestD = Math.max(d, 0.0001);
          }
        }
        if (best) this.onSelect?.([best.i], mode);
        else if (mode === 'replace') this.onSelect?.([], 'replace');
      }
      down = null;
      boxing = false;
    });
    el.addEventListener('pointerleave', () => {
      if (boxing) this.band.classList.add('hidden');
      down = null;
      boxing = false;
    });
  }

  _drawLabels() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return; // panel hidden
    const ctx = this.labelCanvas.getContext('2d');
    this.labelCanvas.width = w;
    this.labelCanvas.height = h;
    ctx.clearRect(0, 0, w, h);
    if (this.labelMode === 'off' || !this.data.length) return;
    const pts = this._project().filter(Boolean);
    pts.sort((a, b) => a.z - b.z);
    const cap = Math.min(pts.length, LABEL_CAP);
    ctx.font = '10px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (let k = 0; k < cap; k++) {
      const p = pts[k];
      const d = this.data.find ? this.dataByIndex(p.i) : null;
      const text = this.labelMode === 'index' ? String(p.i) : (d?.name ?? String(p.i));
      ctx.fillStyle = this.selection.has(p.i) ? '#7fe7ee' : 'rgba(220, 226, 240, 0.75)';
      ctx.fillText(text, p.x + this.pointSize / 2 + 3, p.y);
    }
  }

  dataByIndex(i) {
    // engine order guarantees data[k].index === k
    return this.data[i] && this.data[i].index === i ? this.data[i] : this.data.find((p) => p.index === i);
  }

  _renderGizmo() {
    const size = 76;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (w < size * 2 || h < size) return;
    // The triad lives at the gizmo-scene origin, and the inset camera is
    // derived purely from the main camera's ROTATION: its position is the
    // camera's backward axis scaled to a fixed distance and its quaternion
    // is copied verbatim. That puts the world origin exactly at the inset's
    // center every frame, so panning (target offset), model transforms, frame
    // actions, and viewport resets cannot introduce any positional drift.
    this.gizmoCam.position.set(0, 0, 4.2).applyQuaternion(this.camera.quaternion);
    this.gizmoCam.quaternion.copy(this.camera.quaternion);
    this.renderer.setViewport(w - size, 0, size, size);
    this.renderer.setScissor(w - size, 0, size, size);
    this.renderer.setScissorTest(true);
    this.renderer.render(this.gizmoScene, this.gizmoCam);
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, w, h);
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.labelsDirty = true;
  }
}
