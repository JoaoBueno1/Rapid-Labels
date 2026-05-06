/**
 * Container Builder — Read-only view (share link)
 *
 * Loads a saved plan by ?id=<uuid> and renders metrics, 3D viewport,
 * and load plan. No edit controls.
 */

import * as THREE from 'three';

const CONTAINERS = {
  '20ft': { label: "20' Standard",  L:  589.8, W: 235.2, H: 239.3, maxKg: 28180 },
  '40ft': { label: "40' Standard",  L: 1203.2, W: 235.2, H: 239.3, maxKg: 26680 },
  '40HC': { label: "40' High Cube", L: 1203.2, W: 235.2, H: 269.8, maxKg: 26580 },
};
const PALETTE = ['#E85D04','#0077B6','#52B788','#F77F00','#9D4EDD','#DC2F02','#0096C7','#2A9D8F'];
const API = '/api/container-builder';

const state = {
  plan: null,
  cartons: [],
  result: { containers: [], unplaced: [] },
  colors: {},
  viz: null,
  activeContainerIdx: 0,
};

const $ = id => document.getElementById(id);
const fmt = (n, d=0) => Number(n||0).toLocaleString('en-US', { minimumFractionDigits:d, maximumFractionDigits:d });
const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const utilColor = p => p<50?'#DC2F02':p<75?'#F77F00':p<92?'#52B788':'#E85D04';

// ─── Packer (mirrors packer.js) ─────────────────────────────────────
function packAll(cartons, cdims) {
  const inst = [];
  for (const c of cartons) {
    const qty = Math.max(0, Math.floor(Number(c.qty)||0));
    if (qty === 0 || !(c.L>0 && c.W>0 && c.H>0)) continue;
    const v = c.L*c.W*c.H;
    for (let i = 0; i < qty; i++) inst.push({ sku:c.sku, L:c.L, W:c.W, H:c.H, kg:Number(c.kg)||0, volume:v });
  }
  inst.sort((a,b) => b.volume - a.volume);
  const ctrs = [], unplaced = [];
  for (const it of inst) {
    let placed = false;
    for (const c of ctrs) if (place(it, c, cdims)) { placed = true; break; }
    if (!placed) {
      const nc = { items: [], eps: [{ x:0,y:0,z:0 }], weight: 0 };
      if (place(it, nc, cdims)) ctrs.push(nc);
      else unplaced.push({ sku: it.sku });
    }
  }
  return { containers: ctrs, unplaced };
}
function place(item, ctr, dims) {
  const rots = [{l:item.L,w:item.W,h:item.H},{l:item.W,w:item.L,h:item.H}];
  let best = null;
  for (let ei = 0; ei < ctr.eps.length; ei++) {
    const ep = ctr.eps[ei];
    for (const r of rots) {
      if (ep.x+r.l > dims.L+0.01) continue;
      if (ep.y+r.w > dims.W+0.01) continue;
      if (ep.z+r.h > dims.H+0.01) continue;
      if (ctr.weight+item.kg > dims.maxKg) continue;
      const box = { x:ep.x, y:ep.y, z:ep.z, l:r.l, w:r.w, h:r.h };
      if (overlaps(box, ctr.items)) continue;
      if (!supported(box, ctr.items)) continue;
      const score = box.z*10000 + box.x + box.y*0.01;
      if (!best || score < best.score) best = { box, ei, score };
    }
  }
  if (!best) return false;
  ctr.items.push({ sku: item.sku, kg: item.kg, ...best.box });
  ctr.weight += item.kg;
  ctr.eps.splice(best.ei, 1);
  const b = best.box;
  for (const ne of [{x:b.x+b.l,y:b.y,z:b.z},{x:b.x,y:b.y+b.w,z:b.z},{x:b.x,y:b.y,z:b.z+b.h}]) {
    if (!ctr.eps.some(e => Math.abs(e.x-ne.x)<0.01 && Math.abs(e.y-ne.y)<0.01 && Math.abs(e.z-ne.z)<0.01)) ctr.eps.push(ne);
  }
  return true;
}
function overlaps(b, items) {
  return items.some(it => !(b.x+b.l<=it.x+0.001||it.x+it.l<=b.x+0.001) && !(b.y+b.w<=it.y+0.001||it.y+it.w<=b.y+0.001) && !(b.z+b.h<=it.z+0.001||it.z+it.h<=b.z+0.001));
}
function supported(b, items) {
  if (b.z < 0.01) return true;
  let cov = 0;
  for (const it of items) {
    if (Math.abs(it.z+it.h - b.z) > 0.01) continue;
    const ox = Math.min(it.x+it.l, b.x+b.l) - Math.max(it.x, b.x);
    const oy = Math.min(it.y+it.w, b.y+b.w) - Math.max(it.y, b.y);
    if (ox > 0 && oy > 0) cov += ox*oy;
  }
  return cov / (b.l*b.w) >= 0.5;
}

// ─── Renderers (read-only) ──────────────────────────────────────────
function renderTopbar() {
  $('vPlanName').textContent = state.plan.name || 'Container Plan';
  $('vStatus').textContent = state.plan.status;
  $('vStatus').className = 'cb-status-pill cb-status-' + state.plan.status;
  if (state.plan.source_ref) {
    $('vSource').textContent = `${state.plan.source_type.toUpperCase()} ${state.plan.source_ref}`;
    $('vSource').style.display = '';
  }
  if (state.plan.created_by) {
    $('vUser').textContent = `👤 ${state.plan.created_by}`;
    $('vUser').style.display = '';
  }
  $('vBtnEdit').href = `/features/container-builder/container-builder.html?id=${state.plan.id}`;

  if (state.plan.status === 'draft') {
    const div = document.createElement('div');
    div.className = 'cb-banner';
    div.textContent = '⚠ This plan is a DRAFT — not ready for warehouse handoff.';
    $('vBanners').appendChild(div);
  }
}

function renderContainerPicker() {
  const el = $('vContainerPicker'); el.innerHTML = '';
  Object.entries(CONTAINERS).forEach(([k, c]) => {
    const d = document.createElement('div');
    d.className = 'cb-container-btn' + (k === state.plan.container_type ? ' active' : '');
    d.style.cursor = 'default';
    d.innerHTML = `<div class="cb-ctr-label">${c.label}</div>
                   <div class="cb-ctr-dims">${(c.L/100).toFixed(1)}×${(c.W/100).toFixed(1)}×${(c.H/100).toFixed(1)} m</div>
                   <div class="cb-ctr-dims">${(c.maxKg/1000).toFixed(1)} t max</div>`;
    el.appendChild(d);
  });
}

function renderTable() {
  $('vCartonCount').textContent = state.cartons.length;
  state.colors = {};
  state.cartons.forEach((c, i) => { state.colors[c.sku] = PALETTE[i % PALETTE.length]; });
  const tb = $('vTbody'); tb.innerHTML = '';
  for (const c of state.cartons) {
    const r = document.createElement('div');
    r.className = 'cb-row';
    r.style.gridTemplateColumns = '12px 1.8fr 0.7fr 0.7fr 0.7fr 0.7fr 0.7fr';
    r.innerHTML = `<div class="cb-chip" style="background:${state.colors[c.sku] || '#ddd'}"></div>
      <div class="mono">${esc(c.sku)}</div>
      <div class="r mono">${c.L}</div>
      <div class="r mono">${c.W}</div>
      <div class="r mono">${c.H}</div>
      <div class="r mono">${c.kg}</div>
      <div class="r mono"><b>${c.qty}</b></div>`;
    tb.appendChild(r);
  }
}

function renderSummary() {
  const tq = state.cartons.reduce((s,c) => s + c.qty, 0);
  const tv = state.cartons.reduce((s,c) => s + c.L*c.W*c.H*c.qty, 0) / 1e6;
  const tk = state.cartons.reduce((s,c) => s + c.kg*c.qty, 0);
  $('vSummary').innerHTML = `<span>Total qty: <b>${fmt(tq)}</b></span><span>SKUs: <b>${state.cartons.length}</b></span><span>Volume: <b>${fmt(tv,2)} m³</b></span><span>Weight: <b>${fmt(tk,0)} kg</b></span>`;
}

function renderMetrics() {
  const tq = state.cartons.reduce((s,c) => s + c.qty, 0);
  const pq = state.result.containers.reduce((s,c) => s + c.items.length, 0);
  const uq = state.result.unplaced.length;
  const tk = state.result.containers.reduce((s,c) => s + c.weight, 0);
  const short = (CONTAINERS[state.plan.container_type] || { label: '?' }).label.split(' ')[0];
  const card = (l, v, u, a) => `<div class="cb-metric ${a?'alert':''}"><div class="cb-metric-label">${l}</div><div class="cb-metric-value"><span class="num">${v}</span><span class="unit">${u}</span></div></div>`;
  $('vMetrics').innerHTML = card('Containers', state.result.containers.length, short) + card('Loaded', pq, `/ ${tq}`) + card('Unplaced', uq, 'cartons', uq > 0) + card('Weight', fmt(tk,0), 'kg');
}

function renderTabs() {
  const el = $('vContainerTabs'); el.innerHTML = '';
  if (state.result.containers.length <= 1) return;
  state.result.containers.forEach((_, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cb-tab' + (i === state.activeContainerIdx ? ' active' : '');
    b.textContent = `Container ${i+1}`;
    b.addEventListener('click', () => { state.activeContainerIdx = i; renderViz(); renderUtil(); renderLoadPlan(); });
    el.appendChild(b);
  });
}

function renderUtil() {
  const a = state.result.containers[state.activeContainerIdx];
  const el = $('vUtilBars');
  if (!a) { el.innerHTML = ''; return; }
  const d = CONTAINERS[state.plan.container_type], cv = d.L*d.W*d.H;
  const used = a.items.reduce((s, it) => s + it.l*it.w*it.h, 0);
  const vp = (used/cv)*100, wp = (a.weight/d.maxKg)*100;
  const bar = (lab,p,det) => { const c = utilColor(p); return `<div class="cb-util"><div class="cb-util-head"><span class="cb-util-label">${lab}</span><span class="cb-util-value"><span class="pct" style="color:${c}">${p.toFixed(1)}%</span><span class="detail">${det}</span></span></div><div class="cb-util-bar"><div class="cb-util-fill" style="width:${Math.min(100,p)}%;background:${c}"></div></div></div>`; };
  el.innerHTML = bar('Volume', vp, `${(used/1e6).toFixed(2)} / ${(cv/1e6).toFixed(2)} m³`) + bar('Weight', wp, `${fmt(a.weight,0)} / ${fmt(d.maxKg,0)} kg`);
}

function renderLoadPlan() {
  const a = state.result.containers[state.activeContainerIdx];
  const card = $('vLoadCard');
  if (!a || !a.items.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  $('vLoadIdx').textContent = (state.activeContainerIdx+1);
  const d = CONTAINERS[state.plan.container_type], cv = d.L*d.W*d.H;
  const g = {};
  for (const it of a.items) { if (!g[it.sku]) g[it.sku] = { n:0, v:0, k:0 }; g[it.sku].n++; g[it.sku].v += it.l*it.w*it.h; g[it.sku].k += it.kg; }
  const body = $('vLoadBody'); body.innerHTML = '';
  Object.entries(g).sort((a,b) => b[1].v - a[1].v).forEach(([sku, x]) => {
    const r = document.createElement('div'); r.className = 'cb-plan-row';
    r.innerHTML = `<div class="cb-chip" style="background:${state.colors[sku]||'#ddd'}"></div><div class="sku">${esc(sku)}</div><div class="r">${x.n}</div><div class="r">${(x.v/1e6).toFixed(3)}</div><div class="r">${x.k.toFixed(1)}</div><div class="r">${((x.v/cv)*100).toFixed(1)}%</div>`;
    body.appendChild(r);
  });
}

function renderViz() {
  const a = state.result.containers[state.activeContainerIdx];
  const badge = $('vVizBadge');
  const vizEl = $('vViz');
  if (state.viz) {
    cancelAnimationFrame(state.viz.frameId);
    window.removeEventListener('resize', state.viz.onResize);
    if (state.viz.renderer.domElement.parentNode) state.viz.renderer.domElement.parentNode.removeChild(state.viz.renderer.domElement);
    state.viz.renderer.dispose();
    state.viz.scene.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) Array.isArray(o.material) ? o.material.forEach(m => m.dispose()) : o.material.dispose(); });
    state.viz = null;
  }
  if (!a) { badge.textContent = 'No cartons'; return; }
  badge.textContent = `Container ${state.activeContainerIdx+1} / ${state.result.containers.length}  ↻`;

  const d = CONTAINERS[state.plan.container_type];
  const w = vizEl.clientWidth, h = vizEl.clientHeight;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0xfaf8f5);
  const cam = new THREE.PerspectiveCamera(35, w/h, 1, 20000);
  const r = new THREE.WebGLRenderer({ antialias: true });
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
    const mesh = new THREE.Mesh(g, m); mesh.position.set(it.x+it.l/2, it.z+it.h/2, it.y+it.w/2); scene.add(mesh);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }));
    e.position.copy(mesh.position); scene.add(e);
  }

  const cx = d.L/2, cy = d.H/2, cz = d.W/2, md = Math.max(d.L, d.W, d.H);
  let ang = 0.6, fid;
  const tick = () => { ang += 0.0025; const rr = md*1.25; cam.position.set(cx+Math.cos(ang)*rr, d.H*1.0, cz+Math.sin(ang)*rr); cam.lookAt(cx, cy*0.85, cz); r.render(scene, cam); fid = requestAnimationFrame(tick); };
  tick();
  const onResize = () => { const ww = vizEl.clientWidth, hh = vizEl.clientHeight; r.setSize(ww, hh); cam.aspect = ww/hh; cam.updateProjectionMatrix(); };
  window.addEventListener('resize', onResize);
  state.viz = { renderer: r, scene, camera: cam, frameId: fid, onResize };
}

function toast(msg, kind='') {
  const el = $('cbToast');
  el.className = 'cb-toast' + (kind ? ` cb-toast-${kind}` : '');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.style.display = 'none'; }, 3000);
}

async function exportPDF() {
  try {
    let pngB64 = null;
    if (state.viz && state.viz.renderer && state.viz.renderer.domElement) {
      try { pngB64 = state.viz.renderer.domElement.toDataURL('image/png'); }
      catch (e) { console.warn('canvas capture failed', e); }
    }
    toast('Generating PDF…');
    const res = await fetch(`${API}/plans/${state.plan.id}/export/pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vizPngBase64: pngB64 }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `container-plan-${state.plan.name || state.plan.id}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('PDF downloaded', 'ok');
  } catch (e) { toast('PDF failed: ' + e.message, 'error'); }
}

async function init() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  if (!id) {
    document.querySelector('main').innerHTML = '<div class="cb-error">Missing ?id= in URL.</div>';
    return;
  }
  try {
    const r = await fetch(`${API}/plans/${id}`);
    const json = await r.json();
    if (!json.success) throw new Error(json.error || 'Plan load failed');
    state.plan = json.data;
    state.cartons = (json.data.lines || []).map(l => ({
      sku: l.sku,
      L: Number(l.carton_l_cm) || 0,
      W: Number(l.carton_w_cm) || 0,
      H: Number(l.carton_h_cm) || 0,
      kg: Number(l.carton_kg) || 0,
      qty: Number(l.qty_cartons) || 0,
    }));
    state.result = packAll(state.cartons, CONTAINERS[state.plan.container_type]);

    renderTopbar();
    renderContainerPicker();
    renderTable();
    renderSummary();
    renderMetrics();
    renderTabs();
    renderViz();
    renderUtil();
    renderLoadPlan();

    $('vBtnPDF').addEventListener('click', exportPDF);
  } catch (e) {
    document.querySelector('main').innerHTML = `<div class="cb-error" style="margin:20px">Failed to load plan: ${esc(e.message)}</div>`;
  }
}

init();
