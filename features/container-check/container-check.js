/**
 * Container Check — Frontend (QC de recebimento / inbound)
 *
 * Vanilla script. Usa o cliente Supabase do front (supabase-config.js →
 * window.supabase / window.supabaseReady) só pra subir foto direto pro
 * Storage. Todo o resto vai pela API REST.
 *
 * Fluxo: New record → red (se Wrong/Missing) ou pending → aba "Need Review"
 * → o revisor confirma "tratado" → green. Tudo logado (aba Records).
 */
(function () {
  'use strict';

  const API     = '/api/container-check';
  const BUCKET  = 'container-check';
  const LABELS  = ['OK', 'Wrong', 'Missing', 'N/A'];
  const MAX_PHOTOS = 4;
  const PAGE_SIZE  = 50;

  const state = {
    user:       localStorage.getItem('containerCheckUser') || '',
    records:    [],
    page:       1,
    pageSize:   PAGE_SIZE,
    total:      0,
    pageCount:  1,
    editingId:  null,
    form:       { ocl: null, icl: null, bar: null },
    photos:     [],          // [{url,label}]
    uploading:  0,
    acTimer:    null,
  };

  // ── tiny helpers ────────────────────────────────────────────────
  const $   = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const lvClass = (v) => (v === 'N/A' ? 'NA' : v);
  const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const fmtTime = (iso) => { try { return new Date(iso).toLocaleString(); } catch (_) { return iso || ''; } };
  const fmtDate = (d) => { const s = String(d || '').slice(0, 10); const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); return m ? `${m[3]}-${m[2]}-${m[1]}` : s; }; // YYYY-MM-DD → DD-MM-YYYY

  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'cc-toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    $('ccToast').appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }
  function banner(msg, kind) {
    $('ccBanners').innerHTML = msg ? `<div class="cc-banner ${kind || ''}">${esc(msg)}</div>` : '';
  }

  // Name is captured PER ACTION (Recorded by on new, Reviewed by on review) —
  // not page-wide. We just remember the last one to pre-fill the fields.
  function lastUser()      { try { return localStorage.getItem('containerCheckUser') || ''; } catch (_) { return ''; } }
  function rememberUser(u) { try { if (u) localStorage.setItem('containerCheckUser', u); } catch (_) {} }

  async function api(path, opts) {
    opts = opts || {};
    const headers = { 'Content-Type': 'application/json' };
    if (opts.method && opts.method !== 'GET') {
      const u = (opts.user || '').trim();
      if (!u) throw new Error('Enter your name first.');
      headers['x-cc-user'] = u;
      rememberUser(u);
    }
    const res = await fetch(API + path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    let json = {};
    try { json = await res.json(); } catch (_) {}
    if (!res.ok || !json.success) throw new Error((json && json.error) || `HTTP ${res.status}`);
    return json.data;
  }

  // ════════════════════════════════════════════════════════════════
  // TABS
  // ════════════════════════════════════════════════════════════════
  function switchTab(tab) {
    document.querySelectorAll('.cc-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $('ccTabRecords').style.display = tab === 'records' ? '' : 'none';
    $('ccTabReview').style.display  = tab === 'review'  ? '' : 'none';
    if (tab === 'records') loadRecords();
    else loadReview();
  }

  // ════════════════════════════════════════════════════════════════
  // RECORDS TAB (paginated)
  // ════════════════════════════════════════════════════════════════
  function filtersQS() {
    const qs = new URLSearchParams();
    if ($('ccFrom').value)          qs.set('from', $('ccFrom').value);
    if ($('ccTo').value)            qs.set('to', $('ccTo').value);
    if ($('ccStatusFilter').value)  qs.set('status', $('ccStatusFilter').value);
    if ($('ccSearch').value.trim()) qs.set('q', $('ccSearch').value.trim());
    qs.set('page', state.page);
    qs.set('pageSize', state.pageSize);
    return qs.toString();
  }
  async function loadRecords() {
    const tb = $('ccTbody');
    tb.innerHTML = '<div class="cc-empty">Loading…</div>';
    try {
      const data = await api('/records?' + filtersQS());
      state.records   = data.items || [];
      state.total     = data.total || 0;
      state.page      = data.page || 1;
      state.pageCount = data.pageCount || 1;
      renderMetrics(data.summary || {});
      renderTable(state.records);
      renderPagination();
      banner('');
    } catch (e) {
      tb.innerHTML = `<div class="cc-empty">Error: ${esc(e.message)}</div>`;
      $('ccPager').innerHTML = '';
      banner('Failed to load: ' + e.message, 'cc-banner-error');
    }
  }
  function reloadFromFirstPage() { state.page = 1; loadRecords(); }

  function renderMetrics(s) {
    const rate = s.total ? (s.issue_rate * 100).toFixed(1) : '0.0';
    const bs = s.by_status || { green: 0, red: 0, pending: 0 };
    const lbl = (k) => {
      const o = (s.by_label && s.by_label[k]) || {};
      return `${k.toUpperCase()} <b>${(o.Wrong || 0) + (o.Missing || 0)}</b>`;
    };
    $('ccMetrics').innerHTML = `
      <div class="cc-metric"><div class="cc-metric-label">Total Records</div><div class="cc-metric-value"><span class="num">${s.total || 0}</span></div></div>
      <div class="cc-metric"><div class="cc-metric-label">Items OK</div><div class="cc-metric-value"><span class="num">${s.ok || 0}</span></div></div>
      <div class="cc-metric ${s.issues ? 'alert' : ''}"><div class="cc-metric-label">With issues</div><div class="cc-metric-value"><span class="num">${s.issues || 0}</span></div></div>
      <div class="cc-metric ${s.issues ? 'alert' : ''}"><div class="cc-metric-label">Issue Rate</div><div class="cc-metric-value"><span class="num">${rate}</span><span class="unit">%</span></div></div>
      <div class="cc-metric" style="grid-column:span 2">
        <div class="cc-metric-label">Status</div>
        <div class="cc-metric-pills"><span>🔴 ${bs.red || 0}</span><span>🟡 ${bs.pending || 0}</span><span>🟢 ${bs.green || 0}</span></div>
      </div>
      <div class="cc-metric" style="grid-column:span 2">
        <div class="cc-metric-label">Labels with issues</div>
        <div class="cc-metric-pills"><span>${lbl('ocl')}</span><span>${lbl('icl')}</span><span>${lbl('bar')}</span></div>
      </div>`;
  }

  function lvCell(v, extraClass) {
    if (!v) return `<div class="${extraClass}"><span class="cc-lv cc-lv-blank">·</span></div>`;
    return `<div class="${extraClass}"><span class="cc-lv cc-lv-${lvClass(v)}">${esc(v)}</span></div>`;
  }

  function renderTable(items) {
    const tb = $('ccTbody');
    if (!items.length) { tb.innerHTML = '<div class="cc-empty">No records. Click “＋ New record”.</div>'; return; }
    tb.innerHTML = items.map(r => {
      const nPhoto = Array.isArray(r.photos) ? r.photos.length : 0;
      return `<div class="cc-row" data-id="${r.id}">
        <div class="cc-row-date">${esc(fmtDate(r.check_date))}</div>
        <div class="cc-row-5dc">${esc(r.five_dc || '')}</div>
        <div class="cc-row-code">${esc(r.rapid_code || '')}</div>
        <div class="cc-row-po">${esc(r.po || '')}</div>
        <div class="cc-row-qty r">${r.qty != null ? esc(r.qty) : ''}</div>
        ${lvCell(r.ocl, 'cc-row-ocl c')}
        ${lvCell(r.icl, 'cc-row-icl c')}
        ${lvCell(r.bar, 'cc-row-bar c')}
        <div class="cc-row-cam c cc-cam">${nPhoto ? '📷' + (nPhoto > 1 ? nPhoto : '') : ''}</div>
        <div class="cc-row-status c"><span class="cc-pill cc-pill-${r.status}">${esc(r.status)}</span></div>
        <div class="cc-row-by">${esc(r.created_by || '')}</div>
        <div class="cc-row-by">${esc(r.reviewed_by || '')}</div>
        <div class="cc-row-note" title="${esc(r.inventory_notes || '')}">${esc(r.inventory_notes || '')}</div>
      </div>`;
    }).join('');
  }

  function renderPagination() {
    const el = $('ccPager');
    if (!state.total) { el.innerHTML = ''; return; }
    const from = (state.page - 1) * state.pageSize + 1;
    const to   = Math.min(state.total, state.page * state.pageSize);
    el.innerHTML = `
      <span class="cc-pager-info">${from}–${to} of ${state.total}</span>
      <button class="cc-mini-btn" data-pg="first" ${state.page <= 1 ? 'disabled' : ''}>« First</button>
      <button class="cc-mini-btn" data-pg="prev"  ${state.page <= 1 ? 'disabled' : ''}>‹ Prev</button>
      <span class="cc-pager-pos">Page ${state.page} / ${state.pageCount}</span>
      <button class="cc-mini-btn" data-pg="next"  ${state.page >= state.pageCount ? 'disabled' : ''}>Next ›</button>
      <button class="cc-mini-btn" data-pg="last"  ${state.page >= state.pageCount ? 'disabled' : ''}>Last »</button>`;
  }

  // ════════════════════════════════════════════════════════════════
  // FORM (modal) + autocomplete
  // ════════════════════════════════════════════════════════════════
  function buildSegments() {
    document.querySelectorAll('.cc-seg').forEach(seg => {
      const field = seg.dataset.field;
      seg.innerHTML = LABELS.map(v => `<button type="button" class="cc-seg-btn" data-field="${field}" data-val="${v}">${v}</button>`).join('');
    });
  }
  function paintSegments() {
    document.querySelectorAll('.cc-seg-btn').forEach(btn => {
      const sel = state.form[btn.dataset.field] === btn.dataset.val;
      btn.className = 'cc-seg-btn' + (sel ? ' sel-' + lvClass(btn.dataset.val) : '');
    });
    paintSuggest();
  }
  function suggestStatus() {
    const vals = ['ocl', 'icl', 'bar'].map(f => state.form[f]);
    return vals.some(v => v === 'Wrong' || v === 'Missing') ? 'red' : 'pending';
  }
  function paintSuggest() {
    const s = suggestStatus();
    const el = $('ccStatusSuggest');
    el.textContent = s;
    el.className = 'cc-pill cc-pill-' + s;
  }

  // ── Autocomplete (cin7_mirror.products) — sugere, não bloqueia ──
  function onRapidInput() {
    const v = $('ccRapidCode').value.trim();
    clearTimeout(state.acTimer);
    if (v.length < 2) { hideAc(); return; }
    state.acTimer = setTimeout(async () => {
      try {
        const data = await api('/products?q=' + encodeURIComponent(v));
        renderAc(data.items || []);
      } catch (_) { hideAc(); }
    }, 220);
  }
  function renderAc(items) {
    const box = $('ccAcList');
    if (!items.length) { hideAc(); return; }
    box.innerHTML = items.slice(0, 8).map(p =>
      `<div class="cc-ac-item" data-sku="${esc(p.sku)}" data-dc="${esc(p.five_dc)}">
         <span class="cc-ac-sku">${esc(p.sku)}</span><span class="cc-ac-name">${esc(p.name)}</span>
       </div>`).join('');
    box.style.display = 'block';
  }
  function hideAc() { const b = $('ccAcList'); if (b) { b.style.display = 'none'; b.innerHTML = ''; } }

  function openForm(record) {
    state.editingId = record ? record.id : null;
    state.form = { ocl: record?.ocl || null, icl: record?.icl || null, bar: record?.bar || null };
    state.photos = record && Array.isArray(record.photos) ? record.photos.slice() : [];
    $('ccFormTitle').textContent = record ? 'Edit record' : 'New record';
    $('ccDate').value      = record?.check_date || today();
    $('ccRapidCode').value = record?.rapid_code || '';
    $('ccFiveDc').value    = record?.five_dc || '';
    $('ccQty').value       = record?.qty ?? '';
    $('ccPo').value        = record?.po || '';
    $('ccNotes').value     = record?.inventory_notes || '';
    $('ccRecordedBy').value = record?.created_by || lastUser();
    hideAc();
    paintSegments();
    renderPhotos();
    $('ccFormModal').style.display = 'flex';
    setTimeout(() => $('ccRapidCode').focus(), 50);
  }
  function closeForm() { hideAc(); $('ccFormModal').style.display = 'none'; }

  async function saveForm() {
    const rapid_code = $('ccRapidCode').value.trim();
    if (!rapid_code) { toast('Rapid Code is required', 'err'); $('ccRapidCode').focus(); return; }
    const recordedBy = $('ccRecordedBy').value.trim();
    if (!recordedBy) { toast('Recorded by (your name) is required', 'err'); $('ccRecordedBy').focus(); return; }
    if (state.uploading > 0) { toast('Wait for photos to finish uploading…'); return; }

    const body = {
      check_date:      $('ccDate').value || today(),
      rapid_code,
      five_dc:         $('ccFiveDc').value.trim(),
      qty:             $('ccQty').value,
      po:              $('ccPo').value.trim(),
      ocl:             state.form.ocl,
      icl:             state.form.icl,
      bar:             state.form.bar,
      photos:          state.photos,
      inventory_notes: $('ccNotes').value.trim(),
    };
    // New record: engine forces `pending` (goes to Need Review). On edit we
    // do NOT touch status here — review owns it.

    const btn = $('ccFormSave'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      if (state.editingId) await api('/records/' + state.editingId, { method: 'PUT', body, user: recordedBy });
      else                 await api('/records', { method: 'POST', body, user: recordedBy });
      closeForm();
      toast('Saved ✓', 'ok');
      loadRecords();
    } catch (e) {
      toast('Error saving: ' + e.message, 'err');
    } finally {
      btn.disabled = false; btn.textContent = 'Save';
    }
  }

  // ── Photos ──────────────────────────────────────────────────────
  function renderPhotos() {
    const wrap = $('ccPhotos');
    const thumbs = state.photos.map((p, i) =>
      `<div class="cc-photo-thumb"><img src="${esc(p.url)}" alt="" data-zoom="${esc(p.url)}"><button type="button" class="cc-photo-rm" data-rm="${i}">×</button></div>`
    ).join('');
    const canAdd = state.photos.length < MAX_PHOTOS;
    wrap.innerHTML = thumbs + (canAdd
      ? `<label class="cc-photo-add" id="ccPhotoAddLabel"><span>📷 +</span><input type="file" id="ccPhotoInput" accept="image/*" multiple hidden></label>`
      : '');
    const input = $('ccPhotoInput');
    if (input) input.addEventListener('change', onPhotoPick);
  }

  function resizeImage(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) { height = Math.round(height * maxDim / width); width = maxDim; }
        else if (height > maxDim) { width = Math.round(width * maxDim / height); height = maxDim; }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/jpeg', quality || 0.72);
        URL.revokeObjectURL(img.src);
      };
      img.onerror = () => reject(new Error('invalid image'));
      img.src = URL.createObjectURL(file);
    });
  }

  async function uploadPhoto(blob) {
    await window.supabaseReady;
    const code = ($('ccRapidCode').value.trim() || 'item').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const date = $('ccDate').value || today();
    const rand = Math.random().toString(36).slice(2, 7);
    const path = `${date}/${code}-${Date.now()}-${rand}.jpg`;
    const { error } = await window.supabase.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false });
    if (error) throw error;
    const { data } = window.supabase.storage.from(BUCKET).getPublicUrl(path);
    return data.publicUrl;
  }

  async function onPhotoPick(ev) {
    const files = Array.from(ev.target.files || []);
    ev.target.value = '';
    for (const file of files) {
      if (state.photos.length >= MAX_PHOTOS) { toast(`Max ${MAX_PHOTOS} photos`); break; }
      const wrap = $('ccPhotos');
      const ph = document.createElement('div');
      ph.className = 'cc-photo-thumb uploading';
      ph.innerHTML = '<span class="cc-photo-spin">⏳</span>';
      wrap.insertBefore(ph, wrap.querySelector('#ccPhotoAddLabel'));
      state.uploading++;
      try {
        const blob = await resizeImage(file, 1280, 0.72);
        const url = await uploadPhoto(blob);
        state.photos.push({ url, label: '' });
      } catch (e) {
        toast('Photo failed: ' + e.message, 'err');
      } finally {
        state.uploading--;
        renderPhotos();
      }
    }
  }

  // ── Lightbox (click to expand + download) ──────────────────────
  function openLightbox(url) {
    $('ccLightboxImg').src = url;
    $('ccLightbox').dataset.url = url;
    $('ccLightbox').style.display = 'flex';
  }
  function closeLightbox() { $('ccLightbox').style.display = 'none'; $('ccLightboxImg').src = ''; }
  async function downloadCurrentImage() {
    const url = $('ccLightbox').dataset.url; if (!url) return;
    const name = (url.split('/').pop() || 'photo.jpg').split('?')[0];
    try {
      const r = await fetch(url); const blob = await r.blob();
      const a = document.createElement('a'); const obj = URL.createObjectURL(blob);
      a.href = obj; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(obj);
    } catch (_) { window.open(url, '_blank', 'noopener'); }
  }
  const photoThumbs = (arr) => (Array.isArray(arr) ? arr : []).map(p =>
    `<button type="button" class="cc-ph" data-zoom="${esc(p.url)}"><img src="${esc(p.url)}" alt="" loading="lazy"></button>`).join('');

  // ════════════════════════════════════════════════════════════════
  // DETAIL (modal) + per-record history
  // ════════════════════════════════════════════════════════════════
  function openDetail(r) {
    $('ccDetailTitle').textContent = r.rapid_code || 'Detail';
    const labelLine = (k, v) => `<span><b>${k}</b> ${v ? `<span class="cc-lv cc-lv-${lvClass(v)}">${esc(v)}</span>` : '<span class="cc-lv cc-lv-blank">·</span>'}</span>`;
    const photos = photoThumbs(r.photos) || '<span style="opacity:.5;font-size:12px">no photos</span>';
    const note = (k, v) => v ? `<div class="cc-detail-note"><span class="k">${k}</span>${esc(v)}</div>` : '';
    const reviewed = r.reviewed_by ? `<div><div class="k">Reviewed by</div><div class="v">${esc(r.reviewed_by)} · ${esc(fmtTime(r.reviewed_at))}</div></div>` : '';
    $('ccDetailBody').innerHTML = `
      <div class="cc-detail-grid">
        <div><div class="k">Date</div><div class="v">${esc(r.check_date || '')}</div></div>
        <div><div class="k">Status</div><div class="v"><span class="cc-pill cc-pill-${r.status}">${esc(r.status)}</span></div></div>
        <div><div class="k">5DC</div><div class="v">${esc(r.five_dc || '—')}</div></div>
        <div><div class="k">QTY</div><div class="v">${r.qty != null ? esc(r.qty) : '—'}</div></div>
        <div><div class="k">PO</div><div class="v">${esc(r.po || '—')}</div></div>
        <div><div class="k">Logged by</div><div class="v">${esc(r.created_by || '—')}</div></div>
        ${reviewed}
      </div>
      <div style="display:flex;gap:16px;margin-bottom:10px;font-size:13px;flex-wrap:wrap">
        ${labelLine('OCL', r.ocl)} ${labelLine('ICL', r.icl)} ${labelLine('Bar', r.bar)}
      </div>
      <div class="cc-detail-photos">${photos}</div>
      ${note('Notes (inventory)', r.inventory_notes)}
      ${note('Review', r.reviewer_notes)}
      <div class="cc-modal-actions" style="margin-top:14px">
        <button class="cc-btn cc-btn-secondary" id="ccDetailEdit" type="button">Edit</button>
      </div>
      <div class="cc-history" id="ccDetailHistory"><div class="cc-hist-title">History</div><div class="cc-hist-body">loading…</div></div>`;
    $('ccDetailEdit').addEventListener('click', () => { closeDetail(); openForm(r); });
    $('ccDetailModal').style.display = 'flex';
    loadHistory(r.id);
  }
  function closeDetail() { $('ccDetailModal').style.display = 'none'; }

  function actionLabel(a) {
    return { created: '➕ Created', updated: '✏️ Edited', reviewed: '✅ Reviewed', deleted: '🗑️ Deleted' }[a] || a;
  }
  function histDetails(action, d) {
    if (!d) return '';
    const bits = [];
    if (action === 'created') { ['ocl','icl','bar'].forEach(k => { if (d[k]) bits.push(`${k.toUpperCase()} ${d[k]}`); }); if (d.photos) bits.push(`${d.photos} photo(s)`); }
    if (action === 'reviewed' && d.to_status) bits.push(`→ ${d.to_status}`);
    if (action === 'updated' && Array.isArray(d.changed) && d.changed.length) bits.push('changed: ' + d.changed.join(', '));
    if (d.photos_added)   bits.push(`+${d.photos_added} photo`);
    if (d.photos_removed) bits.push(`−${d.photos_removed} photo`);
    return bits.length ? ` <span class="cc-hist-d">(${esc(bits.join(' · '))})</span>` : '';
  }
  async function loadHistory(id) {
    const body = $('ccDetailHistory') && $('ccDetailHistory').querySelector('.cc-hist-body');
    if (!body) return;
    try {
      const data = await api('/records/' + id + '/log');
      const items = data.items || [];
      if (!items.length) { body.innerHTML = `<div class="cc-hist-empty">${data.note ? esc(data.note) : 'no history yet'}</div>`; return; }
      body.innerHTML = items.map(l =>
        `<div class="cc-hist-row"><span class="cc-hist-act">${actionLabel(l.action)}</span>${histDetails(l.action, l.details)}
           <span class="cc-hist-meta">${esc(l.actor || '—')} · ${esc(fmtTime(l.created_at))}</span></div>`).join('');
    } catch (e) {
      body.innerHTML = `<div class="cc-hist-empty">history unavailable: ${esc(e.message)}</div>`;
    }
  }

  // ════════════════════════════════════════════════════════════════
  // REVIEW TAB
  // ════════════════════════════════════════════════════════════════
  async function loadReview() {
    const list = $('ccReviewList');
    list.innerHTML = '<div class="cc-empty">Loading…</div>';
    try {
      const data = await api('/review');
      const items = data.items || [];
      const badge = $('ccReviewBadge');
      badge.textContent = items.length;
      badge.style.display = items.length ? '' : 'none';
      if (!items.length) { list.innerHTML = '<div class="cc-empty">Nothing to review 🎉</div>'; return; }
      const lv = (k, v) => `<span><b>${k}</b> ${v ? `<span class="cc-lv cc-lv-${lvClass(v)}">${esc(v)}</span>` : '<span class="cc-lv cc-lv-blank">·</span>'}</span>`;
      const uname = esc(lastUser());
      list.innerHTML = items.map(r => `
        <div class="cc-review-card" data-id="${r.id}">
          <div class="cc-review-head">
            <span class="cc-review-code">${esc(r.rapid_code || '')}</span>
            <span class="cc-review-meta">${esc(fmtDate(r.check_date))} · <span class="cc-pill cc-pill-${r.status}">${esc(r.status)}</span> · QTY ${r.qty != null ? esc(r.qty) : '—'} · PO ${esc(r.po || '—')} · by ${esc(r.created_by || '—')}</span>
          </div>
          <div class="cc-review-labels">${lv('OCL', r.ocl)} ${lv('ICL', r.icl)} ${lv('Bar', r.bar)}</div>
          ${r.inventory_notes ? `<div class="cc-detail-note"><span class="k">Inventory notes</span>${esc(r.inventory_notes)}</div>` : ''}
          <div class="cc-detail-photos">${photoThumbs(r.photos) || '<span style="opacity:.5;font-size:12px">no photos</span>'}</div>
          <div class="cc-review-actions">
            <input type="text" class="cc-rv-name" data-name="${r.id}" placeholder="Your name" value="${uname}" autocomplete="off" />
            <textarea data-note="${r.id}" rows="1" placeholder="Comment (optional)…">${esc(r.reviewer_notes || '')}</textarea>
            <button class="cc-rv-confirm" data-confirm="${r.id}">✅ Confirm treated</button>
          </div>
        </div>`).join('');
    } catch (e) {
      list.innerHTML = `<div class="cc-empty">Error: ${esc(e.message)}</div>`;
    }
  }

  async function reviewItem(id) {
    const nameEl = document.querySelector(`input[data-name="${id}"]`);
    const reviewer = nameEl ? nameEl.value.trim() : '';
    if (!reviewer) { toast('Enter your name first', 'err'); if (nameEl) nameEl.focus(); return; }
    if (!window.confirm('Confirm this record is treated and ready? It moves to 🟢 Green.')) return;
    const ta = document.querySelector(`textarea[data-note="${id}"]`);
    const reviewer_notes = ta ? ta.value.trim() : '';
    try {
      await api('/records/' + id, { method: 'PUT', body: { status: 'green', reviewer_notes }, user: reviewer });
      toast('Reviewed ✓', 'ok');
      loadReview();
    } catch (e) { toast('Error: ' + e.message, 'err'); }
  }

  // ════════════════════════════════════════════════════════════════
  // WIRING
  // ════════════════════════════════════════════════════════════════
  function init() {
    buildSegments();

    document.querySelectorAll('.cc-tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

    $('ccBtnNew').addEventListener('click', () => openForm(null));
    $('ccFormClose').addEventListener('click', closeForm);
    $('ccFormCancel').addEventListener('click', closeForm);
    $('ccFormSave').addEventListener('click', saveForm);
    $('ccDetailClose').addEventListener('click', closeDetail);

    $('ccBtnFilter').addEventListener('click', reloadFromFirstPage);
    $('ccBtnClearFilter').addEventListener('click', () => {
      $('ccFrom').value = ''; $('ccTo').value = ''; $('ccStatusFilter').value = ''; $('ccSearch').value = '';
      reloadFromFirstPage();
    });
    $('ccSearch').addEventListener('keydown', e => { if (e.key === 'Enter') reloadFromFirstPage(); });

    // pagination
    $('ccPager').addEventListener('click', e => {
      const b = e.target.closest('[data-pg]'); if (!b || b.disabled) return;
      const pg = b.dataset.pg;
      if (pg === 'first') state.page = 1;
      else if (pg === 'prev') state.page = Math.max(1, state.page - 1);
      else if (pg === 'next') state.page = Math.min(state.pageCount, state.page + 1);
      else if (pg === 'last') state.page = state.pageCount;
      loadRecords();
    });

    // segmented label selectors (delegated)
    document.querySelector('.cc-labels').addEventListener('click', e => {
      const btn = e.target.closest('.cc-seg-btn'); if (!btn) return;
      state.form[btn.dataset.field] = (state.form[btn.dataset.field] === btn.dataset.val) ? null : btn.dataset.val;
      paintSegments();
    });

    // autocomplete on Rapid Code
    $('ccRapidCode').addEventListener('input', onRapidInput);
    $('ccRapidCode').addEventListener('keydown', e => { if (e.key === 'Escape') hideAc(); });
    $('ccAcList').addEventListener('mousedown', e => {   // mousedown fires before input blur
      const it = e.target.closest('.cc-ac-item'); if (!it) return;
      $('ccRapidCode').value = it.dataset.sku;
      if (it.dataset.dc && !$('ccFiveDc').value.trim()) $('ccFiveDc').value = it.dataset.dc;
      hideAc();
    });

    // photos: add input + remove + zoom (delegated)
    const pin = $('ccPhotoInput'); if (pin) pin.addEventListener('change', onPhotoPick);
    $('ccPhotos').addEventListener('click', e => {
      const rm = e.target.closest('[data-rm]');
      if (rm) { state.photos.splice(Number(rm.dataset.rm), 1); renderPhotos(); return; }
      const zoom = e.target.closest('[data-zoom]');
      if (zoom) openLightbox(zoom.dataset.zoom);
    });

    // lightbox: zoom from detail/review photos + controls
    document.addEventListener('click', e => {
      const z = e.target.closest('.cc-ph[data-zoom]'); if (z) { openLightbox(z.dataset.zoom); }
    });
    $('ccLightboxClose').addEventListener('click', closeLightbox);
    $('ccLightboxDownload').addEventListener('click', downloadCurrentImage);
    $('ccLightbox').addEventListener('click', e => { if (e.target === $('ccLightbox')) closeLightbox(); });

    // table interactions (delegated) — row opens detail (delete removed from table)
    $('ccTbody').addEventListener('click', e => {
      const row = e.target.closest('.cc-row'); if (!row) return;
      const r = state.records.find(x => String(x.id) === row.dataset.id);
      if (r) openDetail(r);
    });

    // review interactions (delegated) — the single Confirm button
    $('ccReviewList').addEventListener('click', e => {
      const b = e.target.closest('[data-confirm]'); if (!b) return;
      reviewItem(b.dataset.confirm);
    });

    // close modals on backdrop click + Esc
    [$('ccFormModal'), $('ccDetailModal')].forEach(m => m.addEventListener('click', e => { if (e.target === m) m.style.display = 'none'; }));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeForm(); closeDetail(); closeLightbox(); } });

    loadRecords();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
