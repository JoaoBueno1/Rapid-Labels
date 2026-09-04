'use strict';
/**
 * A folha de contagem da filial.
 *
 * Sem login: quem conta está de pé no armazém com o celular, e exigir senha
 * é o que faz a contagem não acontecer. O token do link tem 128 bits.
 *
 * A filial vê o estoque do sistema ao lado do campo e sabe na hora se bate —
 * foi assim que o time pediu, e é como a planilha sempre funcionou.
 *
 * Salvamento automático, em lote e com atraso: 44 campos digitados em
 * sequência não podem virar 44 requisições. O que sai é o acumulado desde o
 * último envio, e o indicador em cima diz em que pé está.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const token = (location.pathname.match(/\/count\/([A-Za-z0-9]+)/) || [])[1]
    || new URLSearchParams(location.search).get('token') || '';
  const API = '/api/cyclic-count/form/' + encodeURIComponent(token);

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const dmy = (d) => {
    const s = String(d || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.split('-').reverse().join('/') : '—';
  };

  const S = { round: null, lines: [], dirty: new Map(), saving: false, timer: null, done: false };

  async function api(path, opts) {
    const r = await fetch(API + path, Object.assign({
      headers: { 'Content-Type': 'application/json' },
    }, opts || {}));
    let b = null;
    try { b = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error((b && (b.message || b.error)) || `HTTP ${r.status}`);
    return b;
  }

  // ── carregar ─────────────────────────────────────────────────────────
  async function load() {
    if (!token) return state('This link is not valid', 'The address is missing its code. Use the link from the email.');
    try {
      const d = await api('');
      S.round = d.round; S.lines = d.lines || [];
      render();
    } catch (e) {
      // Vazio nunca é erro: aqui é claramente erro, e a tela diz qual.
      state('We could not open this count', e.message, true);
    }
  }

  function state(title, msg, retry) {
    $('body').innerHTML = `<div class="state"><b>${esc(title)}</b>${esc(msg || '')}
      ${retry ? '<br><button type="button" id="again">Try again</button>' : ''}</div>`;
    const a = $('again');
    if (a) a.addEventListener('click', load);
  }

  function render() {
    const r = S.round;
    $('hd').hidden = false;
    $('hBranch').textContent = r.branch_name;
    $('hSub').textContent = `Stock count · week of ${dmy(r.week_start)} · list ${r.list_name}`
      + (r.due_date ? ` · due ${dmy(r.due_date)}` : '');
    $('hSnap').innerHTML = `Each line shows what our system holds for your warehouse as at
      <b>${esc(r.snapshot_label)}</b>. Count the shelf and type what you find.`;

    if (!S.lines.length) {
      $('body').innerHTML = '<div class="note warn"><b>This sheet has no items.</b> Let the office know before you start counting.</div>';
      return;
    }

    if (!r.editable) return renderDone();

    $('prog').hidden = false;
    $('foot').hidden = false;
    $('body').innerHTML = '<div class="rows">' + S.lines.map(rowHtml).join('') + '</div>';
    $('body').addEventListener('input', onInput);
    $('body').addEventListener('focusin', (e) => {
      const row = e.target.closest('.row');
      if (row) row.classList.add('on');
    });
    // Enter salta para o próximo campo em vez de enviar o formulário. Quem
    // conta digita número-Enter-número-Enter, e um Enter que entrega a folha
    // pela metade é irreversível.
    $('body').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const all = Array.from(document.querySelectorAll('.row input'));
      const i = all.indexOf(e.target);
      if (i >= 0 && all[i + 1]) all[i + 1].focus();
      else e.target.blur();
    });
    updateProgress();
  }

  const rowHtml = (l) => `<div class="row ${cls(l)}" data-sku="${esc(l.sku)}">
      <div class="row-main">
        <div class="row-sku">${esc(l.sku)}</div>
        <div class="row-desc">${esc(l.product_name || '')}</div>
        <div class="row-code">${esc(l.sku_code || '')}</div>
      </div>
      <div class="row-sys"><em>System</em><b>${num(l.system_qty)}</b></div>
      <input type="number" inputmode="numeric" min="0" step="1"
             value="${l.counted_qty == null ? '' : l.counted_qty}"
             aria-label="Counted quantity for ${esc(l.sku)}">
      <div class="mark">${mark(l)}</div>
    </div>`;

  const num = (v) => (v == null ? '—' : new Intl.NumberFormat('en-AU').format(Number(v)));
  const cls = (l) => (l.counted_qty == null ? '' : Number(l.counted_qty) === Number(l.system_qty) ? 'match' : 'diff');
  const mark = (l) => (l.counted_qty == null ? '' : Number(l.counted_qty) === Number(l.system_qty) ? '✓' : '≠');

  function onInput(e) {
    if (e.target.tagName !== 'INPUT') return;
    const row = e.target.closest('.row');
    const sku = row.dataset.sku;
    const line = S.lines.find((l) => l.sku === sku);
    if (!line) return;

    const raw = e.target.value.trim();
    const v = raw === '' ? null : Number(raw);
    if (v != null && (!isFinite(v) || v < 0)) { row.className = 'row on'; return; }

    line.counted_qty = v;
    S.dirty.set(sku, v);
    row.className = 'row on ' + cls(line);
    row.querySelector('.mark').textContent = mark(line);
    updateProgress();
    scheduleSave();
  }

  function updateProgress() {
    const done = S.lines.filter((l) => l.counted_qty != null).length;
    const total = S.lines.length;
    $('pCount').textContent = `${done} / ${total}`;
    $('pBar').className = 'bar' + (done === total ? ' done' : '');
    $('pBar').firstElementChild.style.width = (total ? (done / total) * 100 : 0) + '%';
    $('submit').disabled = done !== total;
    $('submit').textContent = done === total ? 'Submit' : `${total - done} to go`;
  }

  // ── salvamento automático ────────────────────────────────────────────
  function scheduleSave() {
    setSave('…', '');
    clearTimeout(S.timer);
    S.timer = setTimeout(flush, 1200);
  }

  async function flush() {
    if (S.saving || !S.dirty.size) return;
    S.saving = true;
    const batch = Object.fromEntries(S.dirty);
    S.dirty.clear();
    try {
      await api('/save', { method: 'POST', body: JSON.stringify({ counts: batch, by: $('by').value || null }) });
      setSave(S.dirty.size ? '…' : 'Saved', 'on');
    } catch (e) {
      // O que falhou volta para a fila — a menos que já tenha sido digitado
      // de novo, e nesse caso o valor novo é o que vale.
      for (const [k, v] of Object.entries(batch)) if (!S.dirty.has(k)) S.dirty.set(k, v);
      setSave('Not saved', 'bad');
      note('bad', '<b>We could not save just now.</b> Keep counting — it will try again. Do not close the page until it says Saved.');
    } finally {
      S.saving = false;
      if (S.dirty.size) scheduleSave();
    }
  }

  function setSave(text, cls2) {
    const el = $('pSave');
    el.textContent = text;
    el.className = 'save ' + (cls2 || '');
  }

  let noteT;
  function note(kind, html) {
    let el = $('note');
    if (!el) {
      el = document.createElement('div');
      el.id = 'note';
      $('body').prepend(el);
    }
    el.className = 'note ' + kind;
    el.innerHTML = html;
    clearTimeout(noteT);
    if (kind !== 'bad') noteT = setTimeout(() => el.remove(), 6000);
  }

  // Fechar a aba com coisa por salvar é como se perde meia hora de contagem.
  window.addEventListener('beforeunload', (e) => {
    if (!S.dirty.size || S.done) return;
    e.preventDefault();
    e.returnValue = '';
  });
  // Sair da aba no celular normalmente MATA o timer. Descarrega na hora.
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

  // ── entregar ─────────────────────────────────────────────────────────
  $('submit').addEventListener('click', async () => {
    const btn = $('submit');
    if (btn.disabled) return;
    const by = $('by').value.trim();
    if (!by) { note('warn', 'Put your name in first — we need to know who counted.'); $('by').focus(); return; }

    btn.disabled = true;
    const was = btn.textContent;
    btn.textContent = 'Submitting…';
    try {
      clearTimeout(S.timer);
      await flush();
      if (S.dirty.size) throw new Error('Some lines have not saved yet. Wait for "Saved" and try again.');
      await api('/submit', { method: 'POST', body: JSON.stringify({ by }) });
      S.done = true;
      const d = await api('');
      S.round = d.round; S.lines = d.lines || [];
      $('prog').hidden = true;
      $('foot').hidden = true;
      window.scrollTo(0, 0);
      renderDone();
    } catch (e) {
      note('bad', `<b>Not submitted.</b> ${esc(e.message)}`);
      btn.disabled = false;
      btn.textContent = was;
    }
  });

  // ── recibo ───────────────────────────────────────────────────────────
  function renderDone() {
    const r = S.round;
    const diff = S.lines.filter((l) => l.counted_qty != null && Number(l.counted_qty) !== Number(l.system_qty));
    $('prog').hidden = true;
    $('foot').hidden = true;
    $('body').innerHTML = `
      <div class="note ok"><b>Count submitted. Thank you.</b><br>
        ${esc(r.branch_name)} · week of ${dmy(r.week_start)}
        ${r.submitted_by ? ` · counted by ${esc(r.submitted_by)}` : ''}</div>
      ${diff.length
        ? `<div class="note info">${diff.length} line${diff.length === 1 ? '' : 's'} did not match the system.
             The office will look into ${diff.length === 1 ? 'it' : 'them'} — nothing else for you to do.</div>`
        : '<div class="note info">Every line matched the system.</div>'}
      <table class="done-tbl"><thead><tr><th>SKU</th><th class="n">System</th><th class="n">Counted</th></tr></thead>
        <tbody>${S.lines.map((l) => `<tr><td>${esc(l.sku)}</td>
          <td class="n">${num(l.system_qty)}</td><td class="n">${num(l.counted_qty)}</td></tr>`).join('')}</tbody></table>`;
  }

  load();
})();
