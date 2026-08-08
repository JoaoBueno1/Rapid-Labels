/* Sync Monitor — two tabs over ops.sync_health().
 *
 * Read-only, anon key, one RPC per load. Deliberately does NOT talk to the
 * GitHub API: "next run" is derived from the stored cron expression, so the
 * page needs no token and keeps working if Actions is unreachable.
 */
(() => {
  'use strict';

  const SUPABASE_URL = 'https://iaqnxamnjftwqdbsnfyl.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlhcW54YW1uamZ0d3FkYnNuZnlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE5NTc5MzQsImV4cCI6MjA2NzUzMzkzNH0.k3G4Tc6U7XdYGmU9wTkcg3R1cLRij-CN6EbjSSbd9bE';

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  let ROWS = [];
  let KIND = 'cin7_to_system';

  /* ── cron ──────────────────────────────────────────────────────────────
   * Only the subset the workflows use: lists, ranges and steps on the five
   * standard fields. Enough for every schedule in .github/workflows, and small
   * enough to read. Returns the next UTC Date, or null if it cannot tell.
   */
  function cronField(expr, min, max) {
    if (expr === '*') return null;                  // null = "every value"
    const out = new Set();
    for (const part of expr.split(',')) {
      const [range, stepRaw] = part.split('/');
      const step = stepRaw ? parseInt(stepRaw, 10) : 1;
      let lo, hi;
      if (range === '*') { lo = min; hi = max; }
      else if (range.includes('-')) { const [a, b] = range.split('-'); lo = +a; hi = +b; }
      else { lo = hi = +range; }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return undefined;
      for (let v = lo; v <= hi; v += step) out.add(v);
    }
    return out;
  }

  function nextRun(cron, from = new Date()) {
    if (!cron) return null;
    const f = cron.trim().split(/\s+/);
    if (f.length !== 5) return null;
    const mins = cronField(f[0], 0, 59), hrs = cronField(f[1], 0, 23);
    const doms = cronField(f[2], 1, 31), mons = cronField(f[3], 1, 12);
    const dows = cronField(f[4], 0, 6);
    if ([mins, hrs, doms, mons, dows].some(x => x === undefined)) return null;

    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(),
                                from.getUTCHours(), from.getUTCMinutes()));
    d.setUTCMinutes(d.getUTCMinutes() + 1, 0, 0);
    // Cron's own rule: with both DOM and DOW restricted it fires on EITHER.
    const domR = !!doms, dowR = !!dows;
    for (let i = 0; i < 366 * 24 * 60; i++) {
      const okMon = !mons || mons.has(d.getUTCMonth() + 1);
      const okDom = !domR || doms.has(d.getUTCDate());
      const okDow = !dowR || dows.has(d.getUTCDay());
      const okDay = okMon && (domR && dowR ? (okDom || okDow) : (okDom && okDow));
      if (okDay && (!hrs || hrs.has(d.getUTCHours())) && (!mins || mins.has(d.getUTCMinutes()))) return d;
      d.setUTCMinutes(d.getUTCMinutes() + 1);
    }
    return null;
  }

  /* ── formatting ─────────────────────────────────────────────────────── */
  const pad = n => String(n).padStart(2, '0');

  function ago(mins) {
    if (mins == null) return '—';
    if (mins < 1) return 'just now';
    if (mins < 60) return `${Math.round(mins)} min ago`;
    const h = mins / 60;
    if (h < 24) return `${h.toFixed(h < 10 ? 1 : 0)} h ago`;
    return `${Math.round(h / 24)} d ago`;
  }

  function until(date) {
    if (!date) return '—';
    const mins = (date - Date.now()) / 60000;
    if (mins < 0) return 'due now';
    if (mins < 60) return `in ${Math.round(mins)} min`;
    const h = mins / 60;
    if (h < 24) return `in ${h.toFixed(h < 10 ? 1 : 0)} h`;
    return `in ${Math.round(h / 24)} d`;
  }

  const clock = d => d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
  const dayLabel = d => {
    if (!d) return '';
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - t) / 86400000);
    return days === 0 ? 'today' : days === 1 ? 'tomorrow'
      : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  };

  const LABEL = {
    healthy: 'Healthy', late: 'Late', stale: 'Stale', failed: 'Failed',
    blocked: 'Blocked', unknown: 'No data', disabled: 'Off',
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ── render ─────────────────────────────────────────────────────────── */
  function card(r) {
    const next = nextRun(r.cron_utc);
    const dataAt = r.data_at ? new Date(r.data_at) : null;
    const lastRun = r.last_run_at ? new Date(r.last_run_at) : null;
    const feeds = (r.feeds || []).filter(Boolean);
    const unchanged = r.status === 'healthy' && r.rows_written === 0;

    return `
    <article class="sm-card sm-${esc(r.status)}">
      <header class="sm-card-head">
        <div>
          <h3 class="sm-card-title">${esc(r.title)}</h3>
          <p class="sm-card-what">${esc(r.what_it_does)}</p>
        </div>
        <span class="sm-pill sm-pill-${esc(r.status)}">${LABEL[r.status] || esc(r.status)}</span>
      </header>

      <dl class="sm-facts">
        <div><dt>Last data</dt><dd title="${dataAt ? esc(dataAt.toLocaleString()) : ''}">
          ${ago(r.age_minutes)}${dataAt ? ` <span class="sm-dim">${clock(dataAt)}</span>` : ''}</dd></div>
        <div><dt>Next run</dt><dd title="${r.cron_utc ? esc(r.cron_utc + ' UTC') : 'no schedule'}">
          ${next ? `${until(next)} <span class="sm-dim">${dayLabel(next)} ${clock(next)}</span>`
                 : (r.cron_utc ? esc(r.cron_utc) : 'manual only')}</dd></div>
        <div><dt>Writes to</dt><dd class="sm-mono">${esc(r.target || '—')}</dd></div>
        <div><dt>Reads from</dt><dd class="sm-mono">${esc(r.source || '—')}</dd></div>
      </dl>

      ${feeds.length ? `<div class="sm-feeds">${feeds.map(f => `<span class="sm-chip">${esc(f)}</span>`).join('')}</div>` : ''}

      <footer class="sm-card-foot">
        ${lastRun ? `<span>run ${ago((Date.now() - lastRun) / 60000)}${r.last_run_ms ? ` · ${(r.last_run_ms / 1000).toFixed(1)}s` : ''}${r.rows_written != null ? ` · ${r.rows_written.toLocaleString()} rows` : ''}</span>`
                  : '<span class="sm-dim">no run logged — health from table freshness</span>'}
        ${unchanged ? '<span class="sm-dim">· content unchanged</span>' : ''}
        ${r.last_run_url ? `<a href="${esc(r.last_run_url)}" target="_blank" rel="noopener">log ↗</a>` : ''}
      </footer>

      ${r.last_error ? `<p class="sm-err">${esc(r.last_error)}</p>` : ''}
    </article>`;
  }

  function render() {
    const rows = ROWS.filter(r => r.kind === KIND);
    const grid = document.getElementById('smGrid');

    if (!rows.length) {
      grid.innerHTML = KIND === 'system_to_excel'
        ? `<div class="sm-empty">
             <strong>No Excel connections yet.</strong>
             <p>Each workbook tab is one file in <code>features/excel-sync/specs/bindings/</code>.
                Add it, run <code>python -m engine register</code>, and it appears here.</p>
           </div>`
        : '<div class="sm-empty">Nothing registered.</div>';
    } else {
      grid.innerHTML = rows.map(card).join('');
    }

    const tally = {};
    rows.forEach(r => { tally[r.status] = (tally[r.status] || 0) + 1; });
    const order = ['failed', 'blocked', 'stale', 'late', 'unknown', 'healthy', 'disabled'];
    document.getElementById('smSummary').innerHTML = order
      .filter(s => tally[s])
      .map(s => `<span class="sm-sum sm-sum-${s}"><b>${tally[s]}</b> ${LABEL[s]}</span>`)
      .join('') || '';

    document.getElementById('cntCin7').textContent = ROWS.filter(r => r.kind === 'cin7_to_system').length || '0';
    document.getElementById('cntExcel').textContent = ROWS.filter(r => r.kind === 'system_to_excel').length || '0';
  }

  async function load() {
    const note = document.getElementById('smNote');
    note.hidden = true;
    try {
      // public.sync_health() is a thin wrapper over ops.sync_health(). Going
      // through public keeps ops/excel_sync out of the Data API entirely — the
      // page needs one function, not raw table access — and removes a manual
      // "Exposed schemas" toggle from the deployment.
      const { data, error } = await sb.rpc('sync_health');
      if (error) throw error;
      ROWS = data || [];
      document.getElementById('smUpdated').textContent = 'updated ' + new Date().toLocaleTimeString();
      render();
    } catch (e) {
      document.getElementById('smGrid').innerHTML = '';
      note.hidden = false;
      note.innerHTML = `<strong>Could not read public.sync_health().</strong>
        <p>${esc(e.message || e)}</p>
        <p>Run <code>features/excel-sync/db/001_ops_registry.sql</code> in the Supabase SQL editor.
           No "Exposed schemas" change is needed — the wrapper lives in <code>public</code>.</p>`;
    }
  }

  document.querySelectorAll('.sm-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sm-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      KIND = btn.dataset.kind;
      render();
    });
  });
  document.getElementById('smRefresh').addEventListener('click', load);

  load();
  setInterval(load, 120000);   // the underlying data moves hourly at best
})();
