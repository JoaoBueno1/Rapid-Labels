'use strict';
/**
 * Cyclic Count — a tela de quem gerencia.
 *
 * Quatro abas, um objeto no centro: a RODADA (uma filial, uma semana, uma
 * lista). O board mostra em que pé cada uma está; entrar numa abre a grade
 * que era o bloco semanal da planilha.
 *
 * Regras que este arquivo segue e que a tela quebra se forem ignoradas:
 *   · vazio nunca é igual a erro — "nenhuma rodada" e "a API caiu" são telas
 *     diferentes, porque a primeira é uma semana que ninguém abriu e a
 *     segunda é uma contagem que ninguém vai fazer;
 *   · toda ação em voo trava o botão que a disparou;
 *   · dinheiro passa por Intl, hora leva sufixo de fuso.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const API = '/api/cyclic-count';

  const S = {
    boot: null, week: null, rounds: [], round: null, lines: [],
    lists: [], list: null, listItems: [], recipients: [], pendingSend: null,
  };

  // ── utilidades ───────────────────────────────────────────────────────
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });
  const NUM = new Intl.NumberFormat('en-AU');
  const money = (v) => (v == null || v === '' || isNaN(Number(v)) ? '—' : AUD.format(Number(v)));
  const n0 = (v) => (v == null || v === '' || isNaN(Number(v)) ? '—' : NUM.format(Number(v)));

  const dmy = (d) => {
    const s = String(d || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.split('-').reverse().join('/') : '—';
  };

  /** Hora de Brisbane, sempre com o sufixo. A rede tem três fusos. */
  const bne = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    const p = new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Brisbane', day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d).reduce((a, x) => (a[x.type] = x.value, a), {});
    return `${p.day}/${p.month} ${p.hour}:${p.minute} AEST`;
  };

  const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000)
    .toISOString().slice(0, 10);

  const mondayOf = (iso) => {
    const t = Date.parse(iso + 'T00:00:00Z');
    return new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
  };
  const todayBne = () => new Date(Date.now() + 10 * 3600000).toISOString().slice(0, 10);

  let toastT;
  function toast(msg, bad) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'sp-toast is-on' + (bad ? ' bad' : '');
    clearTimeout(toastT);
    toastT = setTimeout(() => { el.className = 'sp-toast'; }, bad ? 6000 : 2600);
  }

  /** Trava o botão enquanto a ação está em voo. É a defesa contra o duplo envio. */
  async function lock(btn, fn) {
    if (!btn) return fn();
    if (btn.disabled) return undefined;
    const was = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    try { return await fn(); }
    finally { btn.disabled = false; btn.textContent = was; }
  }

  async function api(path, opts) {
    const r = await fetch(API + path, Object.assign({
      headers: { 'Content-Type': 'application/json', 'x-sp-user': who() },
    }, opts || {}));
    let body = null;
    try { body = await r.json(); } catch (_) { /* corpo vazio ou HTML de erro */ }
    if (!r.ok) {
      const e = new Error((body && (body.message || body.error)) || `HTTP ${r.status}`);
      e.status = r.status; e.body = body;
      throw e;
    }
    return body;
  }

  /** Quem está mexendo. Sem login ainda; o nome vai para o audit_log. */
  function who() {
    let v = '';
    try { v = localStorage.getItem('cc.user') || ''; } catch (_) {}
    return v || 'anon';
  }

  function setStatus(text, cls) {
    $('statusText').textContent = text;
    $('statusDot').className = 'sp-dot' + (cls ? ' ' + cls : '');
  }

  const ST_LABEL = {
    draft: 'Not sent', dispatching: 'Sending', sent: 'With the branch',
    submitted: 'Counted', review: 'In review', closed: 'Closed', cancelled: 'Cancelled',
  };
  const stChip = (r) => `<span class="cc-st st-${esc(r.status)}">${esc(ST_LABEL[r.status] || r.status)}</span>` +
    (isLate(r) ? '<span class="cc-late" title="Past its due date">late</span>' : '');
  const isLate = (r) => r.status === 'sent' && r.due_date && String(r.due_date).slice(0, 10) < todayBne();

  const signCls = (v) => (v == null || Number(v) === 0 ? 'cc-zero' : Number(v) < 0 ? 'cc-neg' : 'cc-pos');

  // ── abas ─────────────────────────────────────────────────────────────
  $$('#tabs .sp-tab').forEach((b) => b.addEventListener('click', () => {
    $$('#tabs .sp-tab').forEach((x) => x.classList.toggle('is-on', x === b));
    $$('.sp-view').forEach((v) => v.classList.toggle('is-on', v.dataset.view === b.dataset.view));
    if (b.dataset.view === 'lists' && !S.lists.length) loadLists();
    if (b.dataset.view === 'recipients') loadRecipients();
  }));

  // ══ BOOTSTRAP ════════════════════════════════════════════════════════
  async function boot() {
    try {
      const b = await api('/bootstrap');
      S.boot = b;
      S.week = b.week;
      S.lists = b.lists || [];

      $('wkList').innerHTML = S.lists.filter((l) => l.is_active)
        .map((l) => `<option value="${l.id}">${esc(l.code)} — ${esc(l.name)} (${l.items})</option>`).join('');
      const brOpts = (b.branches || []).map((x) => `<option value="${esc(x.code)}">${esc(x.name)}</option>`).join('');
      $('fBranch').innerHTML = '<option value="">All branches</option>' + brOpts;
      $('hBranch').innerHTML = '<option value="">All branches</option>' + brOpts;
      $('recBranch').innerHTML = brOpts;

      paintStock(b.stock, b.refresh_available);
      if (b.mail && !b.mail.configured) {
        const el = $('mailOff');
        el.hidden = false;
        el.textContent = `Email off — missing ${b.mail.missing.join(', ')}`;
      }
      setStatus(`${(b.branches || []).length} branches · ${S.lists.length} lists`, 'fresh');
      // Os destinatários entram no boot, e não só ao abrir a aba: o aviso
      // "esta filial não tem e-mail" no modal de disparo lê S.recipients, e
      // com a lista vazia ele acusaria TODAS as filiais no primeiro disparo.
      // Um alerta que mente uma vez deixa de ser lido.
      try { S.recipients = await api('/recipients'); } catch (_) { S.recipients = null; }
      await loadBoard();
    } catch (e) {
      setStatus('Failed to load', 'dead');
      $('board').innerHTML = fail('Could not load the module', e.message, 'boot');
    }
  }

  const fail = (title, msg, retry) => `<div class="cc-fail"><b>${esc(title)}</b>
    <span>${esc(msg)}</span>
    <button class="sp-btn" data-retry="${esc(retry)}">Try again</button></div>`;

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-retry]');
    if (!b) return;
    const what = b.dataset.retry;
    if (what === 'boot') boot();
    if (what === 'board') loadBoard();
    if (what === 'lists') loadLists();
    if (what === 'recipients') loadRecipients();
  });

  function paintStock(st, canRefresh) {
    const bar = $('stockBar');
    const age = st && st.age_min;
    $('btnRefreshStock').hidden = !canRefresh;
    if (age == null) {
      bar.className = 'cc-stock is-dead';
      $('stockAge').textContent = 'no stock in the mirror';
      return;
    }
    const h = Math.floor(age / 60);
    const label = age < 60 ? `${age} min old` : `${h}h ${age % 60}m old`;
    bar.className = 'cc-stock' + (age > 90 ? ' is-stale' : '');
    $('stockAge').textContent = `${label} · synced ${bne(st.synced_at)}`;
  }

  // ══ BOARD ════════════════════════════════════════════════════════════
  function weekLabel() {
    $('wkLabel').innerHTML = `Week of ${dmy(S.week)}` +
      `<small>${dmy(S.week)} – ${dmy(addDays(S.week, 6))}` +
      (S.week === mondayOf(todayBne()) ? ' <span class="cc-week-today">this week</span>' : '') + '</small>';
    if (!$('wkDue').value) $('wkDue').value = addDays(S.week, 4);
  }

  $('wkPrev').addEventListener('click', () => { S.week = addDays(S.week, -7); $('wkDue').value = addDays(S.week, 4); loadBoard(); });
  $('wkNext').addEventListener('click', () => { S.week = addDays(S.week, 7); $('wkDue').value = addDays(S.week, 4); loadBoard(); });
  ['fStatus', 'fBranch', 'fAllWeeks'].forEach((id) => $(id).addEventListener('change', loadBoard));

  async function loadBoard() {
    weekLabel();
    $('board').innerHTML = '<div class="sp-loading">Loading rounds…</div>';
    try {
      const qs = new URLSearchParams();
      if (!$('fAllWeeks').checked) qs.set('week', S.week);
      if ($('fStatus').value) qs.set('status', $('fStatus').value);
      if ($('fBranch').value) qs.set('branch', $('fBranch').value);
      const d = await api('/rounds?' + qs.toString());
      S.rounds = d.rounds || [];
      renderTiles();
      renderBoard();
    } catch (e) {
      $('board').innerHTML = fail('Could not load the rounds', e.message, 'board');
      $('tiles').innerHTML = '';
    }
  }

  function renderTiles() {
    const R = S.rounds;
    const open = R.filter((r) => r.status === 'sent');
    const late = open.filter(isLate);
    const toTreat = R.filter((r) => r.status === 'submitted' || r.status === 'review');
    const unex = R.reduce((a, r) => a + Number(r.unexplained_value || 0), 0);
    const noCost = R.reduce((a, r) => a + Number(r.lines_no_cost || 0), 0);

    const tile = (v, label, sub, cls) => `<div class="sp-tile ${cls || ''}">
      <b>${v}</b><em>${esc(label)}</em><small>${sub}</small></div>`;

    $('tiles').innerHTML = [
      tile(n0(open.length), 'With the branch',
        late.length ? `${n0(late.length)} past due` : 'none overdue', late.length ? 'bad' : ''),
      tile(n0(toTreat.length), 'Counted, waiting on us',
        toTreat.length ? 'variances to treat' : 'nothing waiting', toTreat.length ? 'warn' : 'good'),
      tile(money(unex), 'Unexplained',
        'after Ghost and Movement', unex < 0 ? 'bad' : ''),
      // Só aparece quando existe. Um cartão que diz "0 sem custo" todo dia
      // deixa de ser lido, e é justamente ele que avisa que o dinheiro está
      // subcontado.
      noCost ? tile(n0(noCost), 'Lines with no cost', 'the $ figures are understated', 'warn') : '',
    ].join('');
  }

  function renderBoard() {
    const R = S.rounds;
    $('boardCount').textContent = R.length ? `${R.length} round${R.length === 1 ? '' : 's'}` : '';

    if (!R.length) {
      // Vazio ≠ erro. Aqui é uma semana que ninguém abriu — e a tela diz
      // exatamente o que fazer a respeito.
      $('board').innerHTML = `<div class="sp-empty">
        No rounds for the week of ${dmy(S.week)}.<br>
        Pick a list above and press <b>Open the week</b>.</div>`;
      return;
    }

    // A largura é dado, não estilo — mas markup com style= é markup com
    // style=. Vai como data-pct e o JS pinta depois de montar a tabela.
    const prog = (r) => {
      const t = Number(r.lines_total) || 0, c = Number(r.lines_counted) || 0;
      const pct = t ? Math.round((c / t) * 100) : 0;
      return `<span class="cc-prog"><i class="${c && c === t ? 'done' : ''}"><span data-pct="${pct}"></span></i>${c}/${t}</span>`;
    };

    const act = (r) => {
      if (r.status === 'draft') return `<button class="ui-act" data-send="${r.round_id}">Send</button>`;
      if (r.status === 'sent') return `<button class="ui-act" data-copy="${esc(r.token || '')}">Link</button>`;
      if (r.status === 'submitted' || r.status === 'review') return `<button class="ui-act ui-act--warn" data-open="${r.round_id}">Treat</button>`;
      return '';
    };

    const row = (r) => `<tr class="is-click" data-open="${r.round_id}">
      <td class="em">${esc(r.branch_name || r.branch_code)}</td>
      <td>${esc(r.list_code)}<div class="sub">${dmy(r.week_start)}</div></td>
      <td>${stChip(r)}</td>
      <td>${r.sent_at ? esc(bne(r.sent_at)) : '<span class="sub">—</span>'}
          ${r.snapshot_source === 'MIRROR' ? '<div class="sub" title="Snapshot taken from the mirror, not a fresh Cin7 pull">mirror snapshot</div>' : ''}</td>
      <td class="n">${prog(r)}</td>
      <td class="n ${signCls(r.variance_qty)}">${r.lines_counted ? n0(r.variance_qty) : '—'}</td>
      <td class="n ${signCls(r.variance_value)}">${r.lines_counted ? money(r.variance_value) : '—'}</td>
      <td class="n ${signCls(r.unexplained_value)}">${r.lines_counted ? money(r.unexplained_value) : '—'}</td>
      <td class="act">${act(r)}</td></tr>`;

    const waiting = R.filter((r) => r.status === 'submitted' || r.status === 'review').length;
    // A rotina semanal é abrir a semana e mandar para as 8. Um botão por linha
    // transforma isso em 8 cliques e 8 confirmações, e é aí que alguém pula uma
    // filial sem perceber. O disparo em lote é UMA confirmação que lista o que
    // vai sair — inclusive quais filiais estão sem e-mail.
    const drafts = R.filter((r) => r.status === 'draft');
    $('board').innerHTML = `
      <div class="cc-board-head">
        <b>Rounds</b>
        <span>${waiting ? `${n0(waiting)} waiting on us` : (R.some((r) => r.status === 'sent') ? 'waiting on the branches' : 'nothing waiting')}</span>
        <span class="cc-board-tools">${drafts.length > 1
          ? `<button class="sp-btn is-primary" id="btnSendAll">Send all ${drafts.length}</button>` : ''}</span>
      </div>
      <table><thead><tr>
        <th>Branch</th><th>List</th><th>State</th><th>Sent</th>
        <th class="n">Counted</th><th class="n">Var (un)</th><th class="n">Var ($)</th>
        <th class="n">Unexplained</th><th></th>
      </tr></thead><tbody>${R.map(row).join('')}</tbody></table>`;

    $$('#board [data-pct]').forEach((el) => { el.style.width = el.dataset.pct + '%'; });
  }

  // Clique no board: abrir, enviar, copiar link. Delegado porque o corpo
  // é reescrito inteiro a cada carga.
  $('board').addEventListener('click', async (e) => {
    if (e.target.closest('#btnSendAll')) {
      return askSend(S.rounds.filter((r) => r.status === 'draft').map((r) => r.round_id));
    }
    const copy = e.target.closest('[data-copy]');
    if (copy) { e.stopPropagation(); return copyLink(copy.dataset.copy); }
    const send = e.target.closest('[data-send]');
    if (send) { e.stopPropagation(); return askSend([Number(send.dataset.send)]); }
    const open = e.target.closest('[data-open]');
    if (open) openRound(Number(open.dataset.open));
  });

  async function copyLink(token) {
    if (!token) return toast('This round has no link yet', true);
    const url = `${location.origin}/count/${token}`;
    try { await navigator.clipboard.writeText(url); toast('Link copied'); }
    catch (_) { toast(url); }
  }

  // ── abrir a semana ───────────────────────────────────────────────────
  $('btnOpenWeek').addEventListener('click', (e) => lock(e.target, async () => {
    const listId = Number($('wkList').value);
    if (!listId) return toast('Pick a list first', true);
    try {
      const r = await api('/rounds', {
        method: 'POST',
        body: JSON.stringify({ week_start: S.week, list_id: listId, due_date: $('wkDue').value || null }),
      });
      toast(r.created ? `${r.created} round${r.created === 1 ? '' : 's'} opened` : 'Already open for this week and list');
      await loadBoard();
    } catch (err) { toast(err.message, true); }
  }));

  $('btnRefreshStock').addEventListener('click', (e) => lock(e.target, async () => {
    try {
      await api('/stock-refresh', { method: 'POST' });
      toast('Cin7 sync asked to run — the age below will drop when it lands');
      pollStock();
    } catch (err) { toast(err.message, true); }
  }));

  // O sync leva ~40s de chamadas ao Cin7 mais a escrita. Sondar de 15 em 15
  // por 3 minutos cobre isso sem virar um loop que ninguém desliga.
  function pollStock() {
    let n = 0;
    const t = setInterval(async () => {
      if (++n > 12) return clearInterval(t);
      try {
        const st = await api('/stock-freshness');
        paintStock(st, S.boot && S.boot.refresh_available);
        if (st.age_min != null && st.age_min <= 3) { clearInterval(t); toast('Stock refreshed'); }
      } catch (_) { clearInterval(t); }
    }, 15000);
  }

  // ── disparo, com a conversa sobre o snapshot ─────────────────────────
  function askSend(ids, forced) {
    S.pendingSend = { ids, force: Boolean(forced) };
    const rs = S.rounds.filter((r) => ids.includes(r.round_id));
    const st = S.boot && S.boot.stock;
    const noRec = rs.filter((r) => !recipientCount(r.branch_code));
    $('sendGo').hidden = false;
    $('sendTitle').textContent = rs.length === 1
      ? `Send to ${rs[0].branch_name || rs[0].branch_code}` : `Send ${rs.length} rounds`;
    $('sendBody').innerHTML = `
      <p class="sp-hint">The system stock for each line is frozen now, at the moment you send.
        Nothing in this round changes on its own afterwards.</p>
      <p class="sp-hint"><b>Stock mirror:</b> ${st && st.age_min != null ? esc(bne(st.synced_at)) : 'unknown'}</p>
      ${S.recipients === null
        ? '<div class="cc-warn">Could not read the recipient list, so this cannot say which branches have no address. Sending anyway is safe — the sheet is created either way.</div>'
        : noRec.length ? `<div class="cc-warn"><b>${noRec.length} branch(es) have no email set.</b>
        The sheet will still be created — you will have to share the link by hand.
        ${esc(noRec.map((r) => r.branch_name || r.branch_code).join(', '))}</div>` : ''}
      ${forced ? '<div class="cc-warn">Sending with a <b>stale mirror</b>. The round will record it as such.</div>' : ''}`;
    $('mdSend').classList.add('is-on');
  }

  function recipientCount(branch) {
    if (!Array.isArray(S.recipients)) return 1;   // não sabemos: não acusa
    return S.recipients.filter((x) => x.branch_code === branch && x.is_active).length;
  }

  $('sendGo').addEventListener('click', (e) => lock(e.target, async () => {
    const job = S.pendingSend;
    if (!job) return;
    const total = job.ids.length;
    const named = (id) => {
      const r = S.rounds.find((x) => x.round_id === id);
      return (r && (r.branch_name || r.branch_code)) || `#${id}`;
    };

    let frozen = 0; const problems = [];
    for (const id of job.ids) {
      // Oito filiais são oito chamadas em série. Sem isto o operador olha um
      // botão parado por meio minuto sem saber se travou.
      if (total > 1) $('sendBody').innerHTML =
        `<p class="sp-hint">Sending ${frozen + 1} of ${total} — ${esc(named(id))}…</p>`;
      try {
        const r = await api(`/rounds/${id}/dispatch`, {
          method: 'POST', body: JSON.stringify({ force: job.force }),
        });
        frozen++;
        if (r.mail && !r.mail.ok) problems.push(`${named(id)}: ${r.mail.error}`);
      } catch (err) {
        if (err.body && err.body.error === 'stale_stock') {
          // O espelho não muda no meio do laço, então isto só acontece na
          // primeira. Volta a perguntar, agora dizendo que está velho.
          $('mdSend').classList.remove('is-on');
          S.boot.stock = err.body.stock;
          paintStock(err.body.stock, S.boot.refresh_available);
          return askSend(job.ids, true);
        }
        problems.push(`${named(id)}: ${err.message}`);
      }
    }

    await loadBoard();

    // A folha existe para todas que congelaram, mesmo onde o e-mail falhou —
    // são dois fatos, e um resumo que junta os dois faz alguém achar que
    // precisa disparar de novo. O modal fica aberto listando o que falhou.
    if (!problems.length) {
      $('mdSend').classList.remove('is-on');
      toast(`${frozen} count sheet${frozen === 1 ? '' : 's'} sent`);
      return;
    }
    $('sendTitle').textContent = 'Sent, with problems';
    $('sendBody').innerHTML = `
      <div class="cc-warn"><b>${frozen} of ${total} count sheet(s) are live</b> — the branches can
        count through their link. What failed below was the <b>notification</b>, not the sheet.</div>
      <ul class="sp-hint">${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      <p class="sp-hint">Fix the address under <b>Recipients</b> and use <b>Resend email</b> on the
        round, or copy the link and send it by hand.</p>`;
    $('sendGo').hidden = true;
  }));

  // O modal de disparo é reusado; ao fechar volta ao estado de pergunta.
  $('mdSend').addEventListener('click', (e) => {
    if (e.target === $('mdSend') || e.target.hasAttribute('data-close')) $('sendGo').hidden = false;
  });

  // ══ UMA RODADA ═══════════════════════════════════════════════════════
  async function openRound(id) {
    $('vBoard').hidden = true; $('vRound').hidden = false;
    $('rGrid').innerHTML = '<tbody><tr><td class="sp-loading">Loading…</td></tr></tbody>';
    try {
      const d = await api(`/rounds/${id}`);
      S.round = d.round; S.lines = d.lines || []; S.emails = d.emails || [];
      renderRound();
    } catch (e) {
      $('rNotes').innerHTML = `<div class="cc-err">${esc(e.message)}</div>`;
      $('rGrid').innerHTML = '';
    }
  }

  $('btnBack').addEventListener('click', () => {
    $('vRound').hidden = true; $('vBoard').hidden = false; S.round = null;
  });

  function renderRound() {
    const r = S.round;
    $('rTitle').textContent = `${r.branch_name || r.branch_code} — week of ${dmy(r.week_start)} · list ${r.list_code}`;
    $('rStatus').className = `cc-st st-${r.status}`;
    $('rStatus').textContent = ST_LABEL[r.status] || r.status;
    $('btnResend').hidden = r.status !== 'sent';
    $('btnCopyLink').hidden = r.status !== 'sent';
    $('btnClose').hidden = !(r.status === 'submitted' || r.status === 'review');

    const lastMail = (S.emails || [])[0];
    $('rNotes').innerHTML = [
      `<div class="sp-hint">System stock frozen ${esc(bne(r.snapshot_at))}` +
      (r.snapshot_source === 'MIRROR' ? ' — <b>from the mirror</b>, not a fresh Cin7 pull' : '') +
      (r.submitted_at ? ` · counted by ${esc(r.submitted_by || '—')} on ${esc(bne(r.submitted_at))}` : '') + '</div>',
      Number(r.lines_no_cost) ? `<div class="cc-warn"><b>${r.lines_no_cost} line(s) have no unit cost.</b>
        Their variance shows in units but not in dollars, so the money total below is understated.</div>` : '',
      lastMail && lastMail.status === 'FAILED'
        ? `<div class="cc-err"><b>The email did not go out.</b> ${esc(lastMail.error || '')}
           The sheet is live either way — copy the link and send it by hand, or fix the address and resend.</div>` : '',
    ].join('');

    renderGrid();
  }

  function renderGrid() {
    const q = ($('rSearch').value || '').trim().toUpperCase();
    const rows = S.lines.filter((l) => !q || l.sku.includes(q) || String(l.product_name || '').toUpperCase().includes(q));
    const editable = S.round.status === 'submitted' || S.round.status === 'review';
    const counted = S.round.status !== 'draft' && S.round.status !== 'sent';

    const opts = (v) => ['', 'MOVE_TO_GHOST', 'MOVE_FROM_GHOST', 'ADD_TO_STOCK', 'NONE']
      .map((o) => `<option value="${o}"${o === (v || '') ? ' selected' : ''}>${
        o === '' ? '—' : o === 'NONE' ? 'No action' : o.replace(/_/g, ' ').toLowerCase()
          .replace(/^./, (c) => c.toUpperCase())}</option>`).join('');

    const row = (l) => {
      const v = l.counted_qty == null ? null : Number(l.variance_qty);
      const clean = v === 0;
      return `<tr class="sp-ln ${v ? 'has-var' : (l.counted_qty == null ? '' : 'is-clean')}" data-line="${l.id}" data-sku="${esc(l.sku)}">
        <td class="mono">${esc(l.sku_code || '')}</td>
        <td class="em">${esc(l.sku)}</td>
        <td class="clip">${esc(l.product_name || '')}</td>
        <td class="n">${n0(l.system_qty)}</td>
        <td class="n">${l.counted_qty == null ? '<span class="faint">—</span>' : n0(l.counted_qty)}</td>
        <td class="n var ${signCls(v)}">${v == null ? '—' : n0(v)}</td>
        <td class="money ${signCls(l.variance_value)}">${
          l.unit_cost_aud == null && counted ? '<span class="cc-nocost">no cost</span>' : money(l.variance_value)}</td>
        <td class="fix"><input type="number" min="0" step="1" data-f="explain_qty"
             value="${l.explain_qty == null ? '' : l.explain_qty}" ${editable ? '' : 'disabled'}
             title="How many of the difference are accounted for. Always positive."></td>
        <td class="fix"><input type="text" maxlength="60" data-f="explain_location"
             value="${esc(l.explain_location || '')}" ${editable ? '' : 'disabled'} placeholder="GHOST, MAIN…"></td>
        <td class="fix"><input type="text" maxlength="60" data-f="explain_ref"
             value="${esc(l.explain_ref || '')}" ${editable ? '' : 'disabled'} placeholder="TR-48861"></td>
        <td class="fix"><select data-f="action" ${editable ? '' : 'disabled'}>${opts(l.action)}</select></td>
        <td class="money ${signCls(l.unexplained_value)}">${clean && !l.explain_qty ? '<span class="cc-zero">—</span>' : money(l.unexplained_value)}</td>
      </tr>`;
    };

    if (!rows.length) {
      $('rGrid').innerHTML = `<tbody><tr><td class="sp-empty">${q ? 'No SKU matches that search.' : 'This round has no lines.'}</td></tr></tbody>`;
      return;
    }

    $('rGrid').innerHTML = `<thead><tr>
        <th>5DC</th><th>SKU</th><th>Description</th>
        <th class="n">System</th><th class="n">Counted</th><th class="n">Variance</th><th class="n">Value</th>
        <th class="fix">Ghost</th><th class="fix">Where</th><th class="fix">Movement</th><th class="fix">Action</th>
        <th class="n">Unexplained</th>
      </tr></thead><tbody>${rows.map(row).join('')}</tbody>`;

    const shown = rows.length, total = S.lines.length;
    $('rFootScope').textContent = shown === total ? `${total} lines` : `${shown} of ${total} lines`;
  }

  $('rSearch').addEventListener('input', () => { if (S.round) renderGrid(); });

  // Salva a tratativa ao sair do campo. Sem botão Save de propósito: numa
  // grade de 44 linhas, um Save global é o que faz o trabalho de meia hora
  // sumir num refresh acidental.
  $('rGrid').addEventListener('change', async (e) => {
    const f = e.target.closest('[data-f]');
    if (!f) return;
    const tr = f.closest('tr');
    const id = Number(tr.dataset.line);
    const patch = {};
    tr.querySelectorAll('[data-f]').forEach((el) => { patch[el.dataset.f] = el.value; });
    try {
      const upd = await api(`/lines/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      const i = S.lines.findIndex((l) => l.id === id);
      if (i >= 0) Object.assign(S.lines[i], upd);
      renderGrid();
      const d = await api(`/rounds/${S.round.round_id}`);
      S.round = d.round;
      renderRound();
    } catch (err) {
      toast(err.message, true);
      f.focus();
    }
  });

  // Clicar na linha abre a vida daquele SKU nesta filial. É o Summary,
  // dentro da tela, sem remontar nada.
  $('rGrid').addEventListener('click', async (e) => {
    if (e.target.closest('[data-f]')) return;
    const tr = e.target.closest('tr[data-sku]');
    if (!tr) return;
    const sku = tr.dataset.sku;
    $('sideTitle').textContent = sku;
    $('sideBody').innerHTML = '<div class="sp-loading">Loading…</div>';
    $('side').classList.add('is-on');
    try {
      const h = await api(`/history?branch=${encodeURIComponent(S.round.branch_code)}&sku=${encodeURIComponent(sku)}`);
      $('sideBody').innerHTML = h.length ? `
        <p class="sp-hint">${esc(S.round.branch_name || S.round.branch_code)} — every counted week.</p>
        <table class="sp-grid"><thead><tr><th>Week</th><th class="n">System</th><th class="n">Counted</th>
          <th class="n">Var</th><th class="n">Unexpl.</th><th>Movement</th></tr></thead><tbody>
        ${h.map((x) => `<tr><td>${dmy(x.week_start)}</td><td class="n">${n0(x.system_qty)}</td>
          <td class="n">${n0(x.counted_qty)}</td>
          <td class="n ${signCls(x.variance_qty)}">${n0(x.variance_qty)}</td>
          <td class="n ${signCls(x.unexplained_qty)}">${n0(x.unexplained_qty)}</td>
          <td>${esc(x.explain_ref || '')}</td></tr>`).join('')}</tbody></table>`
        : '<div class="sp-empty">No counted week for this SKU at this branch yet.</div>';
    } catch (err) {
      $('sideBody').innerHTML = `<div class="cc-err">${esc(err.message)}</div>`;
    }
  });

  $('sideClose').addEventListener('click', () => $('side').classList.remove('is-on'));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    $('side').classList.remove('is-on');
    $$('.sp-modal.is-on').forEach((m) => m.classList.remove('is-on'));
  });
  $$('.sp-modal').forEach((m) => m.addEventListener('click', (e) => {
    if (e.target === m || e.target.hasAttribute('data-close')) m.classList.remove('is-on');
  }));

  $('btnCopyLink').addEventListener('click', () => copyLink(S.round && S.round.token));
  $('btnResend').addEventListener('click', (e) => lock(e.target, async () => {
    try {
      const r = await api(`/rounds/${S.round.round_id}/resend`, { method: 'POST' });
      toast(r.mail && r.mail.ok ? 'Email sent again' : `Email failed: ${r.mail && r.mail.error}`, !(r.mail && r.mail.ok));
      openRound(S.round.round_id);
    } catch (err) { toast(err.message, true); }
  }));
  $('btnClose').addEventListener('click', (e) => lock(e.target, async () => {
    try {
      await api(`/rounds/${S.round.round_id}/close`, { method: 'POST' });
      toast('Round closed');
      const id = S.round.round_id;
      await loadBoard();
      openRound(id);
    } catch (err) { toast(err.message, true); }
  }));

  // ══ LISTAS ═══════════════════════════════════════════════════════════
  async function loadLists() {
    $('listPick').innerHTML = '<div class="sp-loading">Loading…</div>';
    try {
      S.lists = await api('/lists');
      $('listPick').innerHTML = S.lists.map((l) => `<button data-list="${l.id}"
        class="${S.list && S.list.id === l.id ? 'on' : ''}">${esc(l.code)}
        <small>${esc(l.name)} · ${l.items} items${l.is_active ? '' : ' · inactive'}</small></button>`).join('')
        || '<div class="sp-empty">No list yet.</div>';
      if (S.lists.length && !S.list) openList(S.lists[0].id);
    } catch (e) {
      $('listPick').innerHTML = fail('Could not load the lists', e.message, 'lists');
    }
  }

  $('listPick').addEventListener('click', (e) => {
    const b = e.target.closest('[data-list]');
    if (b) openList(Number(b.dataset.list));
  });

  async function openList(id) {
    $('lGrid').innerHTML = '<tbody><tr><td class="sp-loading">Loading…</td></tr></tbody>';
    try {
      const d = await api(`/lists/${id}`);
      S.list = d.list; S.listItems = d.items || [];
      $$('#listPick [data-list]').forEach((b) => b.classList.toggle('on', Number(b.dataset.list) === id));
      $('lTitle').textContent = `${d.list.code} — ${d.list.name}`;
      $('lCount').textContent = `${S.listItems.length} items`;
      renderListItems();
    } catch (e) {
      $('lGrid').innerHTML = `<tbody><tr><td class="cc-err">${esc(e.message)}</td></tr></tbody>`;
    }
  }

  function renderListItems() {
    if (!S.listItems.length) {
      $('lGrid').innerHTML = '<tbody><tr><td class="sp-empty">This list is empty. Search a SKU above to add the first one.</td></tr></tbody>';
      return;
    }
    $('lGrid').innerHTML = `<thead><tr><th class="n">#</th><th>5DC</th><th>SKU</th>
        <th>Description</th><th class="n">Unit cost</th><th></th></tr></thead><tbody>
      ${S.listItems.map((i, n) => `<tr class="sp-ln">
        <td class="n">${n + 1}</td>
        <td class="mono">${esc(i.sku_code || '')}</td>
        <td class="em">${esc(i.sku)}</td>
        <td class="clip">${esc(i.product_name || '')}</td>
        <td class="n">${i.unit_cost_aud == null ? '<span class="cc-nocost">no cost</span>' : money(i.unit_cost_aud)}</td>
        <td class="n"><button class="ui-act ui-act--danger" data-del="${i.id}">Remove</button></td>
      </tr>`).join('')}</tbody>`;
  }

  $('lGrid').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del]');
    if (!b) return;
    await lock(b, async () => {
      try {
        await api(`/lists/${S.list.id}/items/${b.dataset.del}`, { method: 'DELETE' });
        S.listItems = S.listItems.filter((x) => String(x.id) !== b.dataset.del);
        $('lCount').textContent = `${S.listItems.length} items`;
        renderListItems();
        toast('Removed');
      } catch (err) { toast(err.message, true); }
    });
  });

  let skuT;
  $('skuSearch').addEventListener('input', () => {
    clearTimeout(skuT);
    const q = $('skuSearch').value.trim();
    if (q.length < 2) { $('skuRes').hidden = true; return; }
    skuT = setTimeout(async () => {
      try {
        const rows = await api('/skus?q=' + encodeURIComponent(q));
        $('skuRes').hidden = false;
        $('skuRes').innerHTML = rows.length ? rows.map((r) => `<button data-add="${esc(r.sku)}">
          <b>${esc(r.sku)}</b><small>${esc(r.product_name || '')}</small></button>`).join('')
          : '<button disabled><small>No SKU matches</small></button>';
      } catch (err) { toast(err.message, true); }
    }, 260);
  });

  $('skuRes').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-add]');
    if (!b || !S.list) return;
    await lock(b, async () => {
      try {
        const r = await api(`/lists/${S.list.id}/items`, {
          method: 'POST', body: JSON.stringify({ skus: [b.dataset.add] }),
        });
        toast(r.added ? `${b.dataset.add} added` : 'Already on this list');
        $('skuSearch').value = ''; $('skuRes').hidden = true;
        openList(S.list.id); loadLists();
      } catch (err) { toast(err.message, true); }
    });
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.cc-sku-add')) $('skuRes').hidden = true;
  });

  $('btnNewList').addEventListener('click', () => $('mdList').classList.add('is-on'));
  $('nlSave').addEventListener('click', (e) => lock(e.target, async () => {
    try {
      const r = await api('/lists', {
        method: 'POST',
        body: JSON.stringify({ code: $('nlCode').value, name: $('nlName').value, notes: $('nlNotes').value }),
      });
      $('mdList').classList.remove('is-on');
      $('nlCode').value = $('nlName').value = $('nlNotes').value = '';
      toast(`List ${r.code} created`);
      await loadLists();
      openList(r.id);
    } catch (err) { toast(err.message, true); }
  }));

  // ══ DESTINATÁRIOS ════════════════════════════════════════════════════
  async function loadRecipients() {
    try {
      S.recipients = await api('/recipients');
      renderRecipients();
    } catch (e) {
      $('recGrid').innerHTML = `<tbody><tr><td>${fail('Could not load the recipients', e.message, 'recipients')}</td></tr></tbody>`;
    }
  }

  function renderRecipients() {
    const byBranch = {};
    ((S.boot && S.boot.branches) || []).forEach((b) => { byBranch[b.code] = { name: b.name, rows: [] }; });
    S.recipients.forEach((r) => { if (byBranch[r.branch_code]) byBranch[r.branch_code].rows.push(r); });

    const blocks = Object.entries(byBranch).map(([code, b]) => {
      if (!b.rows.length) {
        return `<tr class="sp-ln"><td class="em">${esc(b.name)}</td>
          <td colspan="3"><span class="cc-nocost">no address — the link has to be shared by hand</span></td></tr>`;
      }
      return b.rows.map((r, i) => `<tr class="sp-ln">
        <td class="em">${i === 0 ? esc(b.name) : ''}</td>
        <td>${esc(r.email)}</td>
        <td>${esc(r.name || '')}</td>
        <td class="n"><button class="ui-act ui-act--danger" data-rec="${r.id}">Remove</button></td>
      </tr>`).join('');
    }).join('');

    $('recGrid').innerHTML = `<thead><tr><th>Branch</th><th>Email</th><th>Name</th><th></th></tr></thead>
      <tbody>${blocks}</tbody>`;
  }

  $('btnAddRec').addEventListener('click', (e) => lock(e.target, async () => {
    try {
      await api('/recipients', {
        method: 'POST',
        body: JSON.stringify({
          branch_code: $('recBranch').value, email: $('recEmail').value, name: $('recName').value,
        }),
      });
      $('recEmail').value = ''; $('recName').value = '';
      toast('Added');
      await loadRecipients();
    } catch (err) { toast(err.message, true); }
  }));

  $('recGrid').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-rec]');
    if (!b) return;
    await lock(b, async () => {
      try {
        await api(`/recipients/${b.dataset.rec}`, { method: 'DELETE' });
        await loadRecipients();
        toast('Removed');
      } catch (err) { toast(err.message, true); }
    });
  });

  // ══ HISTÓRICO ════════════════════════════════════════════════════════
  let histRows = [];
  $('btnHist').addEventListener('click', (e) => lock(e.target, loadHistory));

  async function loadHistory() {
    $('hGrid').innerHTML = '<tbody><tr><td class="sp-loading">Loading…</td></tr></tbody>';
    try {
      const qs = new URLSearchParams();
      if ($('hBranch').value) qs.set('branch', $('hBranch').value);
      if ($('hSku').value.trim()) qs.set('sku', $('hSku').value.trim());
      if ($('hFrom').value) qs.set('from', $('hFrom').value);
      histRows = await api('/history?' + qs.toString());
      if (!histRows.length) {
        $('hGrid').innerHTML = '<tbody><tr><td class="sp-empty">No counted line matches that filter yet.</td></tr></tbody>';
        $('hFoot').textContent = '';
        return;
      }
      $('hGrid').innerHTML = `<thead><tr><th>Week</th><th>Branch</th><th>List</th><th>SKU</th>
          <th class="n">System</th><th class="n">Counted</th><th class="n">Var</th><th class="n">Value</th>
          <th>Movement</th><th class="n">Unexplained</th></tr></thead><tbody>
        ${histRows.map((x) => `<tr class="sp-ln">
          <td>${dmy(x.week_start)}</td><td>${esc(x.branch_name || x.branch_code)}</td>
          <td>${esc(x.list_code)}</td><td class="em">${esc(x.sku)}</td>
          <td class="n">${n0(x.system_qty)}</td><td class="n">${n0(x.counted_qty)}</td>
          <td class="n ${signCls(x.variance_qty)}">${n0(x.variance_qty)}</td>
          <td class="money ${signCls(x.variance_value)}">${money(x.variance_value)}</td>
          <td>${esc(x.explain_ref || '')}</td>
          <td class="money ${signCls(x.unexplained_value)}">${money(x.unexplained_value)}</td>
        </tr>`).join('')}</tbody>`;
      const unex = histRows.reduce((a, x) => a + Number(x.unexplained_value || 0), 0);
      $('hFoot').textContent = `${histRows.length} lines · unexplained ${AUD.format(unex)}`;
    } catch (e) {
      $('hGrid').innerHTML = `<tbody><tr><td>${fail('Could not load the history', e.message, '')}</td></tr></tbody>`;
    }
  }

  $('btnHistCsv').addEventListener('click', () => {
    if (!histRows.length) return toast('Nothing to export — run a search first', true);
    const cols = ['week_start', 'branch_code', 'list_code', 'sku', 'sku_code', 'product_name',
      'system_qty', 'counted_qty', 'variance_qty', 'variance_value',
      'explain_qty', 'explain_location', 'explain_ref', 'action', 'unexplained_qty', 'unexplained_value'];
    const cell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const csv = [cols.join(','), ...histRows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `cyclic-count-history-${todayBne()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  boot();
})();
