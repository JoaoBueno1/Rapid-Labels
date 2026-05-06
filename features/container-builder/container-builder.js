/**
 * Container Builder — Frontend
 *
 * Vanilla ES module. Three.js loaded via import map.
 *
 * Flow A (PO):     "From PO" → pick PO → lines populate → solve → save → confirm
 * Flow B (ad-hoc): "Add SKU" → typeahead → solve → save → confirm
 *
 * State persistence:
 *   - Plans live in cin7_mirror.container_plans / container_plan_lines
 *   - User identity is free-text in localStorage.containerBuilderUser
 *     (no auth in this repo — guardrail, not security)
 */

import * as THREE from 'three';

// ════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════
const CONTAINERS = {
  '20ft': { label: "20' Standard",  L:  589.8, W: 235.2, H: 239.3, maxKg: 28180 },
  '40ft': { label: "40' Standard",  L: 1203.2, W: 235.2, H: 239.3, maxKg: 26680 },
  '40HC': { label: "40' High Cube", L: 1203.2, W: 235.2, H: 269.8, maxKg: 26580 },
};
const PALETTE = ['#E85D04','#0077B6','#52B788','#F77F00','#9D4EDD','#DC2F02','#0096C7','#2A9D8F'];
const API = '/api/container-builder';
const AUTOSAVE_INTERVAL_MS = 30_000;

// ════════════════════════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════════════════════════
const state = {
  user:          null,
  planId:        null,
  planName:      '',
  status:        'draft',
  sourceType:    'adhoc',
  sourceRef:     null,
  containerKey:  '40HC',
  cartons:       [],          // {id,sku,L,W,H,kg,qty,units_per_carton}
  result:        { containers: [], unplaced: [], stats: {} },
  colors:        {},
  viz:           null,
  activeContainerIdx: 0,
  dirty:         false,
  autosaveTimer: null,
};

// ════════════════════════════════════════════════════════════════════
// PACKER (mirror of features/container-builder/packer.js for live preview)
// ════════════════════════════════════════════════════════════════════
const MAX_CONTAINERS = 50;
function packAll(cartons, cdims) {
  const inst = [];
  for (const c of cartons) {
    const qty = Math.max(0, Math.floor(Number(c.qty) || 0));
    if (qty === 0) continue;
    if (!(c.L > 0 && c.W > 0 && c.H > 0)) continue;
    const v = c.L * c.W * c.H;
    for (let i = 0; i < qty; i++) inst.push({ sku: c.sku, L: c.L, W: c.W, H: c.H, kg: Number(c.kg) || 0, volume: v });
  }
  inst.sort((a, b) => b.volume - a.volume);
  const ctrs = [], unplaced = [];
  let hitCap = false;
  for (const it of inst) {
    let placed = false;
    for (const c of ctrs) if (place(it, c, cdims)) { placed = true; break; }
    if (!placed) {
      if (ctrs.length >= MAX_CONTAINERS) { hitCap = true; unplaced.push({ sku: it.sku, reason: 'container_cap_reached' }); continue; }
      const nc = { items: [], eps: [{ x:0, y:0, z:0 }], weight: 0 };
      if (place(it, nc, cdims)) ctrs.push(nc);
      else unplaced.push({ sku: it.sku, reason: (it.L>cdims.L||it.W>cdims.W||it.H>cdims.H)?'too_big':(it.kg>cdims.maxKg?'overweight':'no_support') });
    }
  }
  return { containers: ctrs, unplaced, stats: { totalCartons: inst.length, placedCartons: ctrs.reduce((s,c)=>s+c.items.length,0), containerCount: ctrs.length, unplacedCount: unplaced.length, hitContainerCap: hitCap } };
}
function place(item, ctr, dims) {
  const rots = [{ l: item.L, w: item.W, h: item.H }, { l: item.W, w: item.L, h: item.H }];
  let best = null;
  for (let ei = 0; ei < ctr.eps.length; ei++) {
    const ep = ctr.eps[ei];
    for (const r of rots) {
      if (ep.x + r.l > dims.L + 0.01) continue;
      if (ep.y + r.w > dims.W + 0.01) continue;
      if (ep.z + r.h > dims.H + 0.01) continue;
      if (ctr.weight + item.kg > dims.maxKg) continue;
      const box = { x: ep.x, y: ep.y, z: ep.z, l: r.l, w: r.w, h: r.h };
      if (overlaps(box, ctr.items)) continue;
      if (!supported(box, ctr.items)) continue;
      const score = box.z * 10000 + box.x + box.y * 0.01;
      if (!best || score < best.score) best = { box, ei, score };
    }
  }
  if (!best) return false;
  ctr.items.push({ sku: item.sku, kg: item.kg, ...best.box });
  ctr.weight += item.kg;
  ctr.eps.splice(best.ei, 1);
  const b = best.box;
  for (const ne of [{ x:b.x+b.l, y:b.y, z:b.z }, { x:b.x, y:b.y+b.w, z:b.z }, { x:b.x, y:b.y, z:b.z+b.h }]) {
    if (!ctr.eps.some(e => Math.abs(e.x-ne.x)<0.01 && Math.abs(e.y-ne.y)<0.01 && Math.abs(e.z-ne.z)<0.01)) ctr.eps.push(ne);
  }
  return true;
}
function overlaps(b, items) {
  return items.some(it => !(b.x+b.l <= it.x+0.001 || it.x+it.l <= b.x+0.001) && !(b.y+b.w <= it.y+0.001 || it.y+it.w <= b.y+0.001) && !(b.z+b.h <= it.z+0.001 || it.z+it.h <= b.z+0.001));
}
function supported(b, items) {
  if (b.z < 0.01) return true;
  let cov = 0;
  for (const it of items) {
    if (Math.abs(it.z+it.h - b.z) > 0.01) continue;
    const ox = Math.min(it.x+it.l, b.x+b.l) - Math.max(it.x, b.x);
    const oy = Math.min(it.y+it.w, b.y+b.w) - Math.max(it.y, b.y);
    if (ox > 0 && oy > 0) cov += ox * oy;
  }
  return cov / (b.l * b.w) >= 0.5;
}

// ════════════════════════════════════════════════════════════════════
// UTILITIES
// ════════════════════════════════════════════════════════════════════
function $(id) { return document.getElementById(id); }
function fmt(n, d = 0) { return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
function utilColor(p) { if (p < 50) return '#DC2F02'; if (p < 75) return '#F77F00'; if (p < 92) return '#52B788'; return '#E85D04'; }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function toast(msg, kind = '') {
  const el = $('cbToast');
  el.className = 'cb-toast' + (kind ? ` cb-toast-${kind}` : '');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.style.display = 'none'; }, 3000);
}

function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.user) headers['x-cb-user'] = state.user;
  return fetch(API + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => {
    const txt = await r.text();
    let json;
    try { json = JSON.parse(txt); }
    catch { throw new Error(`Non-JSON response (${r.status})`); }
    if (!json.success) throw new Error(json.error || `HTTP ${r.status}`);
    return json.data ?? json;
  });
}

// ════════════════════════════════════════════════════════════════════
// USER IDENTITY
// ════════════════════════════════════════════════════════════════════
function loadUser() {
  state.user = localStorage.getItem('containerBuilderUser');
  if (!state.user) {
    $('cbUserModal').style.display = 'flex';
  } else {
    $('cbUserTag').textContent = `👤 ${state.user}`;
    $('cbUserTag').style.display = '';
  }
}
function saveUser() {
  const v = $('cbUserInput').value.trim();
  if (!v) { $('cbUserInput').focus(); return; }
  localStorage.setItem('containerBuilderUser', v);
  state.user = v;
  $('cbUserModal').style.display = 'none';
  $('cbUserTag').textContent = `👤 ${state.user}`;
  $('cbUserTag').style.display = '';
}

// ════════════════════════════════════════════════════════════════════
// CARTONS / SOLVE / RENDER
// ════════════════════════════════════════════════════════════════════
function nextId() {
  return Math.max(0, ...state.cartons.map(c => c.id || 0)) + 1;
}
function addCartonFromProduct(p) {
  state.cartons.push({
    id: nextId(),
    sku: p.sku,
    L: Number(p.carton_l_cm) || 0,
    W: Number(p.carton_w_cm) || 0,
    H: Number(p.carton_h_cm) || 0,
    kg: Number(p.carton_kg) || 0,
    qty: 1,
    units_per_carton: Math.max(1, Math.floor(Number(p.units_per_carton) || 1)),
  });
  markDirty();
  renderAll();
}
function addBlankCarton() {
  const id = nextId();
  state.cartons.push({ id, sku: `NEW-${id}`, L: 30, W: 20, H: 15, kg: 2, qty: 1, units_per_carton: 1 });
  markDirty();
  renderAll();
}
function clearCartons() {
  if (!state.cartons.length) return;
  if (!confirm('Clear all cartons from this plan?')) return;
  state.cartons = [];
  markDirty();
  renderAll();
}

function assignColors() {
  state.colors = {};
  state.cartons.forEach((c, i) => { state.colors[c.sku] = PALETTE[i % PALETTE.length]; });
}

function solve() {
  const valid = state.cartons.filter(c => c.sku && c.L > 0 && c.W > 0 && c.H > 0 && c.qty > 0);
  state.result = packAll(valid, CONTAINERS[state.containerKey]);
  if (state.activeContainerIdx >= state.result.containers.length) state.activeContainerIdx = 0;
}

function renderContainerPicker() {
  const el = $('cbContainerPicker'); el.innerHTML = '';
  Object.entries(CONTAINERS).forEach(([k, c]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cb-container-btn' + (k === state.containerKey ? ' active' : '');
    b.innerHTML = `<div class="cb-ctr-label">${c.label}</div>
                   <div class="cb-ctr-dims">${(c.L/100).toFixed(1)}×${(c.W/100).toFixed(1)}×${(c.H/100).toFixed(1)} m</div>
                   <div class="cb-ctr-dims">${(c.maxKg/1000).toFixed(1)} t max</div>`;
    b.addEventListener('click', () => {
      if (state.containerKey === k) return;
      state.containerKey = k;
      state.activeContainerIdx = 0;
      markDirty();
      renderAll();
    });
    el.appendChild(b);
  });
}

function renderTable() {
  $('cbCartonCount').textContent = state.cartons.length;
  const tb = $('cbTbody'); tb.innerHTML = '';
  for (const c of state.cartons) {
    const r = document.createElement('div');
    r.className = 'cb-row' + (!(c.L > 0 && c.W > 0 && c.H > 0) ? ' cb-row-warn' : '');
    r.innerHTML = `<div class="cb-chip" style="background:${state.colors[c.sku] || '#ddd'}"></div>
      <input data-f="sku" value="${esc(c.sku)}" />
      <input class="r" type="number" step="0.1" data-f="L" value="${c.L}" />
      <input class="r" type="number" step="0.1" data-f="W" value="${c.W}" />
      <input class="r" type="number" step="0.1" data-f="H" value="${c.H}" />
      <input class="r" type="number" step="0.1" data-f="kg" value="${c.kg}" />
      <input class="r qty" type="number" step="1" data-f="qty" value="${c.qty}" />
      <button class="cb-del" type="button" title="Remove">×</button>`;
    r.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('input', e => {
        const f = e.target.dataset.f;
        const ct = state.cartons.find(x => x.id === c.id);
        if (!ct) return;
        ct[f] = (f === 'sku') ? e.target.value : (Number(e.target.value) || 0);
        markDirty();
        scheduleSolve();
      });
    });
    r.querySelector('.cb-del').addEventListener('click', () => {
      state.cartons = state.cartons.filter(x => x.id !== c.id);
      markDirty();
      renderAll();
    });
    tb.appendChild(r);
  }
}

function renderSummary() {
  const tq = state.cartons.reduce((s, c) => s + (Number(c.qty) || 0), 0);
  const tv = state.cartons.reduce((s, c) => s + c.L * c.W * c.H * c.qty, 0) / 1e6;
  const tk = state.cartons.reduce((s, c) => s + c.kg * c.qty, 0);
  $('cbSummary').innerHTML = `
    <span>Total qty: <b>${fmt(tq)}</b></span>
    <span>SKUs: <b>${state.cartons.length}</b></span>
    <span>Volume: <b>${fmt(tv, 2)} m³</b></span>
    <span>Weight: <b>${fmt(tk, 0)} kg</b></span>`;
}

function renderMetrics() {
  const tq = state.cartons.reduce((s, c) => s + (Number(c.qty) || 0), 0);
  const pq = state.result.containers.reduce((s, c) => s + c.items.length, 0);
  const uq = state.result.unplaced.length;
  const tk = state.result.containers.reduce((s, c) => s + c.weight, 0);
  const short = CONTAINERS[state.containerKey].label.split(' ')[0];
  const card = (label, val, unit, alert) =>
    `<div class="cb-metric ${alert ? 'alert' : ''}">
       <div class="cb-metric-label">${label}</div>
       <div class="cb-metric-value"><span class="num">${val}</span><span class="unit">${unit}</span></div>
     </div>`;
  $('cbMetrics').innerHTML =
    card('Containers', state.result.containers.length, short) +
    card('Loaded',     pq, `/ ${tq}`) +
    card('Unplaced',   uq, 'cartons', uq > 0) +
    card('Weight',     fmt(tk, 0), 'kg');
}

function renderContainerTabs() {
  const el = $('cbContainerTabs'); el.innerHTML = '';
  const n = state.result.containers.length;

  // Hard ceiling so a runaway solve can't poison the DOM.
  if (n > 50) {
    showBanner(`Solver opened ${n} containers (over the 50 cap). Probable cause: a SKU with very small/zero dimensions or an inflated qty. Check the cartons table.`, 'error');
  }
  if (state.result.stats && state.result.stats.hitContainerCap) {
    showBanner(`Container cap (50) reached. ${state.result.unplaced.length} cartons left unplaced. Fix dimensions or split the plan.`, 'error');
  }

  if (n <= 1) return;
  state.result.containers.slice(0, 50).forEach((_, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cb-tab' + (i === state.activeContainerIdx ? ' active' : '');
    b.textContent = `Container ${i + 1}`;
    b.addEventListener('click', () => { state.activeContainerIdx = i; renderViz(); renderUtil(); renderLoadPlan(); });
    el.appendChild(b);
  });
}

function renderUtil() {
  const a = state.result.containers[state.activeContainerIdx];
  const el = $('cbUtilBars');
  if (!a) { el.innerHTML = ''; return; }
  const d = CONTAINERS[state.containerKey], cv = d.L * d.W * d.H;
  const used = a.items.reduce((s, it) => s + it.l * it.w * it.h, 0);
  const vp = (used / cv) * 100, wp = (a.weight / d.maxKg) * 100;
  const bar = (lab, p, det) => {
    const c = utilColor(p);
    return `<div class="cb-util">
      <div class="cb-util-head"><span class="cb-util-label">${lab}</span>
        <span class="cb-util-value"><span class="pct" style="color:${c}">${p.toFixed(1)}%</span><span class="detail">${det}</span></span></div>
      <div class="cb-util-bar"><div class="cb-util-fill" style="width:${Math.min(100,p)}%;background:${c}"></div></div>
    </div>`;
  };
  el.innerHTML =
    bar('Volume', vp, `${(used/1e6).toFixed(2)} / ${(cv/1e6).toFixed(2)} m³`) +
    bar('Weight', wp, `${fmt(a.weight, 0)} / ${fmt(d.maxKg, 0)} kg`);
}

function renderLoadPlan() {
  const a = state.result.containers[state.activeContainerIdx];
  const card = $('cbLoadplanCard');
  if (!a || !a.items.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  $('cbLoadplanIdx').textContent = (state.activeContainerIdx + 1);
  const d = CONTAINERS[state.containerKey], cv = d.L * d.W * d.H;
  const g = {};
  for (const it of a.items) {
    if (!g[it.sku]) g[it.sku] = { n: 0, v: 0, k: 0 };
    g[it.sku].n++;
    g[it.sku].v += it.l * it.w * it.h;
    g[it.sku].k += it.kg;
  }
  const body = $('cbLoadplanBody'); body.innerHTML = '';
  Object.entries(g).sort((a, b) => b[1].v - a[1].v).forEach(([sku, x]) => {
    const r = document.createElement('div'); r.className = 'cb-plan-row';
    r.innerHTML = `<div class="cb-chip" style="background:${state.colors[sku] || '#ddd'}"></div>
      <div class="sku">${esc(sku)}</div>
      <div class="r">${x.n}</div>
      <div class="r">${(x.v/1e6).toFixed(3)}</div>
      <div class="r">${x.k.toFixed(1)}</div>
      <div class="r">${((x.v/cv)*100).toFixed(1)}%</div>`;
    body.appendChild(r);
  });
}

// ════════════════════════════════════════════════════════════════════
// 3D VIZ
// ════════════════════════════════════════════════════════════════════
function renderViz() {
  const a = state.result.containers[state.activeContainerIdx];
  const badge = $('cbVizBadge');
  const vizEl = $('cbViz');

  // Tear down previous renderer
  if (state.viz) {
    cancelAnimationFrame(state.viz.frameId);
    window.removeEventListener('resize', state.viz.onResize);
    if (state.viz.renderer.domElement.parentNode) state.viz.renderer.domElement.parentNode.removeChild(state.viz.renderer.domElement);
    state.viz.renderer.dispose();
    state.viz.scene.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) Array.isArray(o.material) ? o.material.forEach(m => m.dispose()) : o.material.dispose();
    });
    state.viz = null;
  }

  if (!a) { badge.textContent = 'No cartons'; return; }
  badge.textContent = `Container ${state.activeContainerIdx + 1} / ${state.result.containers.length}  ↻`;

  const d = CONTAINERS[state.containerKey];
  const w = vizEl.clientWidth, h = vizEl.clientHeight;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0xfaf8f5);
  const cam = new THREE.PerspectiveCamera(35, w/h, 1, 20000);
  // preserveDrawingBuffer is required so canvas.toDataURL() works in PDF export
  const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  r.setSize(w, h); r.setPixelRatio(window.devicePixelRatio || 1);
  vizEl.appendChild(r.domElement);

  scene.add(new THREE.AmbientLight(0xffffff, 0.65));
  const l1 = new THREE.DirectionalLight(0xffffff, 0.7); l1.position.set(1000, 2000, 1500); scene.add(l1);
  const l2 = new THREE.DirectionalLight(0xffffff, 0.3); l2.position.set(-500, 1000, -500); scene.add(l2);

  const cg = new THREE.BoxGeometry(d.L, d.H, d.W);
  const cl = new THREE.LineSegments(new THREE.EdgesGeometry(cg), new THREE.LineBasicMaterial({ color: 0x1a1a1a }));
  cl.position.set(d.L/2, d.H/2, d.W/2); scene.add(cl);

  const fl = new THREE.Mesh(new THREE.PlaneGeometry(d.L, d.W), new THREE.MeshLambertMaterial({ color: 0xe8e0d0, transparent: true, opacity: 0.4 }));
  fl.rotation.x = -Math.PI/2; fl.position.set(d.L/2, 0, d.W/2); scene.add(fl);

  for (const it of a.items) {
    const col = state.colors[it.sku] || '#888';
    const g = new THREE.BoxGeometry(it.l, it.h, it.w);
    const m = new THREE.MeshLambertMaterial({ color: col, transparent: true, opacity: 0.88 });
    const mesh = new THREE.Mesh(g, m); mesh.position.set(it.x + it.l/2, it.z + it.h/2, it.y + it.w/2); scene.add(mesh);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }));
    e.position.copy(mesh.position); scene.add(e);
  }

  const cx = d.L/2, cy = d.H/2, cz = d.W/2, md = Math.max(d.L, d.W, d.H);
  let ang = 0.6, fid;
  const tick = () => {
    ang += 0.0025;
    const rr = md * 1.25;
    cam.position.set(cx + Math.cos(ang) * rr, d.H * 1.0, cz + Math.sin(ang) * rr);
    cam.lookAt(cx, cy * 0.85, cz);
    r.render(scene, cam);
    fid = requestAnimationFrame(tick);
  };
  tick();
  const onResize = () => {
    const ww = vizEl.clientWidth, hh = vizEl.clientHeight;
    r.setSize(ww, hh); cam.aspect = ww/hh; cam.updateProjectionMatrix();
  };
  window.addEventListener('resize', onResize);
  state.viz = { renderer: r, scene, camera: cam, frameId: fid, onResize };
}

// ════════════════════════════════════════════════════════════════════
// FULL RE-RENDER
// ════════════════════════════════════════════════════════════════════
function renderAll() {
  assignColors();
  solve();
  renderContainerPicker();
  renderTable();
  renderSummary();
  renderMetrics();
  renderContainerTabs();
  renderViz();
  renderUtil();
  renderLoadPlan();
  renderTopbar();
}

// scheduleSolve = debounced re-solve when a single field changes
const scheduleSolve = debounce(() => {
  assignColors();
  solve();
  renderMetrics();
  renderContainerTabs();
  renderViz();
  renderUtil();
  renderLoadPlan();
  renderSummary();
}, 250);

// ════════════════════════════════════════════════════════════════════
// TOP BAR / STATUS
// ════════════════════════════════════════════════════════════════════
function renderTopbar() {
  $('cbPlanName').value = state.planName || '';
  const pill = $('cbStatusPill');
  pill.textContent = state.status;
  pill.className = 'cb-status-pill cb-status-' + state.status;

  const tag = $('cbSourceTag');
  if (state.sourceRef) {
    tag.textContent = `${state.sourceType.toUpperCase()} ${state.sourceRef}`;
    tag.style.display = '';
  } else {
    tag.style.display = 'none';
  }

  // Confirm/Reopen visibility
  $('btnConfirm').style.display = state.status === 'draft' ? '' : 'none';
  $('btnReopen').style.display  = (state.status === 'confirmed' || state.status === 'loaded') ? '' : 'none';

  // Lock inputs when not draft
  const locked = state.status !== 'draft';
  $('cbPlanName').disabled = locked;
  document.querySelectorAll('#cbTbody input, #cbTbody .cb-del, #btnAddSku, #btnFromPO, #cbBtnClear')
    .forEach(el => el.disabled = locked);
}

function markDirty() {
  state.dirty = true;
}

// ════════════════════════════════════════════════════════════════════
// SAVE / LOAD
// ════════════════════════════════════════════════════════════════════
async function savePlan(silent = false) {
  if (!state.user) { $('cbUserModal').style.display = 'flex'; return; }
  if (!state.cartons.length) { if (!silent) toast('Add at least one carton before saving', 'error'); return; }

  const name = ($('cbPlanName').value || '').trim() || `Plan ${new Date().toLocaleString()}`;
  const lines = state.cartons.map(c => ({
    sku:              c.sku,
    qty_cartons:      c.qty,
    carton_l_cm:      c.L,
    carton_w_cm:      c.W,
    carton_h_cm:      c.H,
    carton_kg:        c.kg,
    units_per_carton: c.units_per_carton || 1,
  }));
  const payload = {
    name,
    container_type: state.containerKey,
    source_type:    state.sourceType,
    source_ref:     state.sourceRef,
    lines,
    result_json:    state.result,
  };

  try {
    if (state.planId) {
      await api('PUT', `/plans/${state.planId}`, payload);
      state.planName = name;
      state.dirty = false;
      if (!silent) toast('Saved', 'ok');
    } else {
      const r = await api('POST', `/plans`, payload);
      state.planId = r.id;
      state.planName = name;
      state.dirty = false;
      window.history.replaceState({}, '', `?id=${r.id}`);
      if (!silent) toast('Created', 'ok');
    }
    renderTopbar();
  } catch (e) {
    console.error('[CB] save failed', e);
    toast('Save failed: ' + e.message, 'error');
  }
}

async function confirmPlan() {
  if (!state.planId) { toast('Save first', 'error'); return; }
  if (!confirm('Confirm this plan? Editing will be locked until reopened.')) return;
  try {
    await api('POST', `/plans/${state.planId}/confirm`);
    state.status = 'confirmed';
    renderTopbar();
    toast('Confirmed', 'ok');
  } catch (e) { toast('Confirm failed: ' + e.message, 'error'); }
}

async function reopenPlan() {
  if (!state.planId) return;
  if (!confirm('Reopen this plan for editing?')) return;
  try {
    await api('POST', `/plans/${state.planId}/reopen`);
    state.status = 'draft';
    renderTopbar();
    toast('Reopened', 'ok');
  } catch (e) { toast('Reopen failed: ' + e.message, 'error'); }
}

async function loadPlan(id) {
  try {
    const p = await api('GET', `/plans/${id}`);
    state.planId       = p.id;
    state.planName     = p.name;
    state.status       = p.status || 'draft';
    state.sourceType   = p.source_type;
    state.sourceRef    = p.source_ref;
    state.containerKey = p.container_type;
    state.cartons      = (p.lines || []).map((l, idx) => ({
      id:               idx + 1,
      sku:              l.sku,
      L:                Number(l.carton_l_cm) || 0,
      W:                Number(l.carton_w_cm) || 0,
      H:                Number(l.carton_h_cm) || 0,
      kg:               Number(l.carton_kg)   || 0,
      qty:              Number(l.qty_cartons) || 0,
      units_per_carton: Number(l.units_per_carton) || 1,
    }));
    state.dirty = false;
    window.history.replaceState({}, '', `?id=${id}`);
    renderAll();
  } catch (e) { toast('Load failed: ' + e.message, 'error'); }
}

async function listMyPlans() {
  $('cbPlansModal').style.display = 'flex';
  $('cbPlansList').innerHTML = '<div class="cb-loader">Loading…</div>';
  try {
    const r = await api('GET', `/plans`);
    const items = r.items || [];
    if (!items.length) {
      $('cbPlansList').innerHTML = '<div class="cb-loader">No plans saved yet.</div>';
      return;
    }
    $('cbPlansList').innerHTML = items.map(p => `
      <div class="cb-plan-card" data-id="${p.id}">
        <div class="nm">${esc(p.name)}<div class="meta">${esc(p.source_type)}${p.source_ref ? ' · ' + esc(p.source_ref) : ''}</div></div>
        <div>${esc(p.container_type)}</div>
        <div><span class="cb-status-pill cb-status-${p.status}">${p.status}</span></div>
        <div class="meta">${esc(p.created_by || '—')}<br>${new Date(p.updated_at).toLocaleString('en-AU')}</div>
        <div><button class="cb-add-btn" type="button">Open</button></div>
      </div>`).join('');
    $('cbPlansList').querySelectorAll('.cb-plan-card').forEach(el => {
      el.addEventListener('click', () => {
        $('cbPlansModal').style.display = 'none';
        loadPlan(el.dataset.id);
      });
    });
  } catch (e) {
    $('cbPlansList').innerHTML = `<div class="cb-error">${esc(e.message)}</div>`;
  }
}

// ════════════════════════════════════════════════════════════════════
// SKU PICKER (typeahead modal)
// ════════════════════════════════════════════════════════════════════
function openSkuPicker() {
  $('cbSkuModal').style.display = 'flex';
  $('cbSkuSearch').value = '';
  $('cbSkuResults').innerHTML = '<div class="cb-loader">Type to search…</div>';
  $('cbSkuSearch').focus();
}
const searchSku = debounce(async () => {
  const q = $('cbSkuSearch').value.trim();
  if (q.length < 2) { $('cbSkuResults').innerHTML = '<div class="cb-loader">Type at least 2 characters…</div>'; return; }
  $('cbSkuResults').innerHTML = '<div class="cb-loader">Searching…</div>';
  try {
    const r = await api('GET', `/products?search=${encodeURIComponent(q)}&limit=50`);
    if (!r.items.length) { $('cbSkuResults').innerHTML = '<div class="cb-loader">No matches.</div>'; return; }
    $('cbSkuResults').innerHTML = r.items.map((p, i) => `
      <div class="cb-sku-row${p.plannable ? '' : ' unplannable'}" data-i="${i}">
        <div class="cb-sku-code">${esc(p.sku)}</div>
        <div class="cb-sku-name">${esc(p.name)}<div class="cb-sku-cat">${esc(p.category || '—')}</div></div>
        <div class="cb-sku-cat">${esc(p.attribute1 || '')}</div>
        <div class="cb-sku-dim">${p.plannable ? `${p.carton_l_cm}×${p.carton_w_cm}×${p.carton_h_cm}` : 'no dims'}</div>
        <div><button class="cb-add-btn" type="button" ${p.plannable ? '' : 'disabled'}>Add</button></div>
      </div>`).join('');
    $('cbSkuResults').querySelectorAll('.cb-sku-row').forEach(row => {
      row.addEventListener('click', () => {
        const p = r.items[Number(row.dataset.i)];
        if (!p.plannable) { toast('SKU has no carton dimensions in Cin7', 'error'); return; }
        addCartonFromProduct(p);
        $('cbSkuModal').style.display = 'none';
      });
    });
  } catch (e) {
    $('cbSkuResults').innerHTML = `<div class="cb-error">${esc(e.message)}</div>`;
  }
}, 250);

// ════════════════════════════════════════════════════════════════════
// PO PICKER
// ════════════════════════════════════════════════════════════════════
async function openPoPicker() {
  $('cbPoModal').style.display = 'flex';
  $('cbPoList').innerHTML = '<div class="cb-loader">Loading from Cin7 (may take a few seconds)…</div>';
  try {
    const r = await api('GET', `/pos`);
    if (!r.items.length) { $('cbPoList').innerHTML = '<div class="cb-loader">No open POs.</div>'; return; }
    $('cbPoList').innerHTML = r.items.map(p => `
      <div class="cb-po-row" data-num="${esc(p.orderNumber)}">
        <div class="num">${esc(p.orderNumber)}</div>
        <div class="sup">${esc(p.supplier || '—')}</div>
        <div class="meta">${p.orderDate ? new Date(p.orderDate).toLocaleDateString('en-AU') : '—'}</div>
        <div class="stat">${esc(p.status)}</div>
        <div><button class="cb-add-btn" type="button">Import</button></div>
      </div>`).join('');
    $('cbPoList').querySelectorAll('.cb-po-row').forEach(el => {
      el.addEventListener('click', () => importPo(el.dataset.num));
    });
  } catch (e) {
    $('cbPoList').innerHTML = `<div class="cb-error">${esc(e.message)}</div>`;
  }
}
async function importPo(orderNumber) {
  $('cbPoList').innerHTML = '<div class="cb-loader">Fetching PO lines…</div>';
  try {
    const r = await api('GET', `/pos/${encodeURIComponent(orderNumber)}/lines`);
    state.cartons = r.cartons.map((c, i) => ({
      id: i + 1,
      sku: c.sku,
      L: Number(c.carton_l_cm) || 0,
      W: Number(c.carton_w_cm) || 0,
      H: Number(c.carton_h_cm) || 0,
      kg: Number(c.carton_kg) || 0,
      qty: Number(c.qty_cartons) || 0,
      units_per_carton: Number(c.units_per_carton) || 1,
    }));
    state.sourceType = 'po';
    state.sourceRef  = r.po.orderNumber;
    state.planName   = state.planName || `PO ${r.po.orderNumber}`;
    markDirty();
    $('cbPoModal').style.display = 'none';
    renderAll();

    if (r.count_unplannable > 0) {
      showBanner(`${r.count_unplannable} of ${r.count_lines} PO lines lack carton dimensions in Cin7. Solver will skip them — fix in Cin7 master data and re-import to plan in full.`, 'warn');
    } else {
      toast(`PO ${r.po.orderNumber} imported (${r.count_lines} lines)`, 'ok');
    }
  } catch (e) {
    $('cbPoList').innerHTML = `<div class="cb-error">${esc(e.message)}</div>`;
  }
}

// ════════════════════════════════════════════════════════════════════
// PDF EXPORT
// ════════════════════════════════════════════════════════════════════
async function exportPDF() {
  if (!state.planId) { await savePlan(true); }
  if (!state.planId) return;
  try {
    let pngB64 = null;
    if (state.viz && state.viz.renderer && state.viz.renderer.domElement) {
      try { pngB64 = state.viz.renderer.domElement.toDataURL('image/png'); }
      catch (e) { console.warn('[CB] canvas capture failed', e); }
    }
    toast('Generating PDF…');
    const headers = { 'Content-Type': 'application/json' };
    if (state.user) headers['x-cb-user'] = state.user;
    const res = await fetch(`${API}/plans/${state.planId}/export/pdf`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ vizPngBase64: pngB64 }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `container-plan-${state.planName || state.planId}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('PDF downloaded', 'ok');
  } catch (e) { toast('PDF failed: ' + e.message, 'error'); }
}

// ════════════════════════════════════════════════════════════════════
// AUDIT PANEL (collapsible)
// ════════════════════════════════════════════════════════════════════
async function loadAudit() {
  $('cbAuditCard').style.display = '';
  const body = $('cbAuditBody');
  body.innerHTML = '<div class="cb-loader">Loading audit…</div>';
  try {
    const d = await api('GET', `/products/audit`);
    const pctClass  = d.pct_complete >= 80 ? 'kpi-good' : d.pct_complete >= 50 ? 'kpi-warn' : 'kpi-bad';
    const lastSync  = d.last_product_synced ? new Date(d.last_product_synced).toLocaleString() : '—';
    const fieldRows = ['carton_length','carton_width','carton_height','carton_quantity','weight','category']
      .map(f => { const m = d.missing_by_field[f] || 0, p = d.total_active ? Math.round((1000*m)/d.total_active)/10 : 0; return `<tr><td><code>${f}</code></td><td>${fmt(m)}</td><td>${p}%</td></tr>`; }).join('');
    const catRows = (d.by_category || []).map(c => `<tr><td>${esc(c.category)}</td><td>${fmt(c.total)}</td><td>${fmt(c.complete)}</td><td><span class="cb-pct-bar"><span style="width:${Math.min(c.pct,100)}%"></span></span>${c.pct}%</td></tr>`).join('');
    const sample = (d.sample_missing || []).map(p => `<tr><td><code>${esc(p.sku)}</code></td><td>${esc(p.name)}</td><td>${esc(p.category || '—')}</td><td>${(p.missing||[]).map(m=>`<span class="cb-missing-tag">${esc(m)}</span>`).join('')}</td></tr>`).join('');
    body.innerHTML = `
      <div class="cb-audit-kpis">
        <div class="cb-audit-kpi"><div class="cb-audit-kpi-value">${fmt(d.total_active)}</div><div class="cb-audit-kpi-label">Active SKUs</div></div>
        <div class="cb-audit-kpi ${pctClass}"><div class="cb-audit-kpi-value">${d.pct_complete}%</div><div class="cb-audit-kpi-label">Carton dims complete</div></div>
        <div class="cb-audit-kpi kpi-good"><div class="cb-audit-kpi-value">${fmt(d.complete_dims)}</div><div class="cb-audit-kpi-label">Plannable today</div></div>
        <div class="cb-audit-kpi kpi-bad"><div class="cb-audit-kpi-value">${fmt(d.total_active - d.complete_dims)}</div><div class="cb-audit-kpi-label">Need data fix</div></div>
      </div>
      <div class="cb-audit-section-title">Missing fields</div>
      <table class="cb-data-table"><thead><tr><th>Field</th><th>Missing</th><th>%</th></tr></thead><tbody>${fieldRows}</tbody></table>
      <div class="cb-audit-section-title">Top categories</div>
      <table class="cb-data-table"><thead><tr><th>Category</th><th>Total</th><th>Complete</th><th>Coverage</th></tr></thead><tbody>${catRows}</tbody></table>
      <div class="cb-audit-section-title">Sample of SKUs needing data fix in Cin7 (first 50)</div>
      <table class="cb-data-table"><thead><tr><th>SKU</th><th>Name</th><th>Category</th><th>Missing</th></tr></thead><tbody>${sample}</tbody></table>
      <div class="cb-meta">Last products sync: <strong>${esc(lastSync)}</strong></div>`;
  } catch (e) {
    body.innerHTML = `<div class="cb-error">${esc(e.message)}</div>`;
  }
}

// ════════════════════════════════════════════════════════════════════
// BANNERS
// ════════════════════════════════════════════════════════════════════
function showBanner(msg, kind) {
  const div = document.createElement('div');
  div.className = 'cb-banner cb-banner-' + (kind || 'info');
  div.textContent = msg;
  $('cbBanners').innerHTML = '';
  $('cbBanners').appendChild(div);
}

// ════════════════════════════════════════════════════════════════════
// AUTOSAVE
// ════════════════════════════════════════════════════════════════════
function startAutosave() {
  if (state.autosaveTimer) clearInterval(state.autosaveTimer);
  state.autosaveTimer = setInterval(() => {
    if (state.dirty && state.status === 'draft' && state.planId) {
      savePlan(true);
    }
  }, AUTOSAVE_INTERVAL_MS);
}

// ════════════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════════════
function bindEvents() {
  $('cbUserSave').addEventListener('click', saveUser);
  $('cbUserInput').addEventListener('keydown', e => { if (e.key === 'Enter') saveUser(); });

  $('cbPlanName').addEventListener('input', () => { state.planName = $('cbPlanName').value; markDirty(); });

  $('btnAddSku').addEventListener('click', openSkuPicker);
  $('btnFromPO').addEventListener('click', openPoPicker);
  $('btnSolve').addEventListener('click', () => { renderAll(); toast('Solved', 'ok'); });
  $('btnSave').addEventListener('click', () => savePlan(false));
  $('btnConfirm').addEventListener('click', confirmPlan);
  $('btnReopen').addEventListener('click', reopenPlan);
  $('btnExportPDF').addEventListener('click', exportPDF);
  $('cbBtnClear').addEventListener('click', clearCartons);

  $('cbSkuSearch').addEventListener('input', searchSku);

  document.querySelectorAll('[data-close]').forEach(el => {
    el.addEventListener('click', () => { $(el.dataset.close).style.display = 'none'; });
  });

  $('navAudit').addEventListener('click', e => { e.preventDefault(); loadAudit(); $('cbAuditCard').scrollIntoView({ behavior: 'smooth' }); });
  $('navMyPlans').addEventListener('click', e => { e.preventDefault(); listMyPlans(); });
  $('cbBtnRefreshAudit').addEventListener('click', loadAudit);
  $('cbBtnHideAudit').addEventListener('click', () => { $('cbAuditCard').style.display = 'none'; });
}

async function init() {
  loadUser();
  bindEvents();
  startAutosave();

  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  if (id) {
    await loadPlan(id);
  } else {
    renderAll();
  }
}

init();
