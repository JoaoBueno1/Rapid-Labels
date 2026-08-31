/* Master Stock — um item por linha, com a ORIGEM de cada valor.
 *
 * A regra que define a tela inteira:
 *   as duas fontes concordam   → um valor, sem cor
 *   só o Cin7 tem              → cor de Cin7
 *   só o arquivo tem           → cor de arquivo
 *   só o Re-Stock tem          → cor de Re-Stock
 *   as duas têm e DIVERGEM     → os DOIS valores, cada um com sua origem
 *
 * O sistema não escolhe em silêncio. Medido no cruzamento: em comprimento há
 * 1.230 SKUs em que Cin7 e arquivo discordam contra 2 em que concordam — se a
 * tela escolhesse uma, apagaria exatamente o que o usuário abriu para ver.
 */
'use strict';
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const n0 = (v) => (v == null || isNaN(v)) ? '' : Math.round(v).toLocaleString('en-AU');
  const n2 = (v) => (v == null || isNaN(v)) ? '' : (Math.round(v * 100) / 100).toLocaleString('en-AU');
  const debounce = (fn, ms = 220) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  const S = { q: '', status: '', gap: '', conflict: false, offset: 0, rows: [], total: 0, counts: null };

  /**
   * O coração da tela. Recebe os dois lados e devolve a célula já classificada.
   * `tol` existe porque medida decimal quase nunca bate exata: 0,02 = 2%.
   */
  function dual(cin7, file, opts = {}) {
    const fmt = opts.fmt || n2;
    const a = cin7 != null && cin7 !== '' , b = file != null && file !== '';
    if (!a && !b) return '<td class="ms-none">·</td>';
    if (a && !b) return `<td class="ms-cin7" title="Only Cin7 has this">${fmt(cin7)}</td>`;
    if (!a && b) return `<td class="ms-file" title="Only the product file has this">${fmt(file)}</td>`;
    const same = opts.text
      ? String(cin7).trim().toUpperCase() === String(file).trim().toUpperCase()
      : Math.abs(Number(cin7) - Number(file)) / Math.max(Math.abs(Number(cin7)), opts.floor || 1) <= (opts.tol || 0.02);
    if (same) return `<td>${fmt(cin7)}</td>`;
    // Divergência: os dois valores, com a origem de cada um. É o caso que o
    // usuário abriu a tela para encontrar e corrigir na fonte.
    return `<td class="ms-conf" title="Cin7 says ${esc(fmt(cin7))}, the product file says ${esc(fmt(file))} — fix whichever is wrong">
      <b>${fmt(cin7)}</b><i>C</i><span>${fmt(file)}</span><i>F</i></td>`;
  }
  const one = (v, cls, tip, fmt) => (v == null || v === '')
    ? '<td class="ms-none">·</td>'
    : `<td class="${cls}" title="${esc(tip)}">${(fmt || n2)(v)}</td>`;

  // As bandeiras vão NA LINHA e não só no filtro: quem está olhando um produto
  // precisa saber que o número dele é suspeito, mesmo sem ter filtrado por isso.
  const FLAGS = [
    ['flag_dim_unit', 'mm', 'Size looks like millimetres stamped as centimetres — the median largest dimension is 20.5cm and this one is over 100'],
    ['flag_stock_no_dim', 'no size', 'Has stock somewhere but no dimension in any source — this is what stops a container being planned'],
    ['flag_pack_sku', 'pack', 'Carton SKU with carton quantity 0 — the pack size lives only in the UOM name, so stock can be double counted'],
    ['flag_file_dim_unit', 'file mm', 'The product file size looks like millimetres, but its CBM column is computed as if it were centimetres — so that CBM is 1000x too big'],
    ['flag_volume_default', 'vol 48cm', 'The volume is 0.110592, which is a 48x48x48cm box. It is the default filled in when nobody measured, and it is the same on 1,927 different products'],
    ['flag_carton_name_mismatch', 'name≠BOM', 'The number in the SKU name and the quantity in the BOM disagree — one of the two is wrong'],
    ['flag_locator_junk', 'loc?', 'Stock locator is not a bin: it is "0" or a process word like BOM or PRODUCTION'],
  ];
  /* A política do SKU, visível na grade e não só dentro do painel.
     São 11.259 linhas: para saber o que alguém já configurou era preciso abrir
     SKU por SKU. Configuração que não se vê de fora ninguém confere.
     A ordem é a mesma de policy_flag na view — as duas telas desenham a mesma
     bandeira, e quem muda uma tem de mudar a outra. */
  const POL = [
    ['lifecycle_status', 'DISCONTINUED', 'disc', 'DISC',
      'Discontinued in Master Stock. Still shows in Stock Planning and Branch Replenishment — there is stock to decide about — but it does not pull a purchase.'],
    ['lifecycle_status', 'RUN_OUT', 'run', 'RUN-OUT',
      'Run-out in Master Stock. Sell what is left; not reordered.'],
  ];
  const politica = (r) => {
    const out = [];
    for (const [campo, valor, cls, txt, tip] of POL)
      if (r[campo] === valor) { out.push(`<i class="ms-pol ms-pol--${cls}" title="${esc(tip)}">${txt}</i>`); break; }
    if (r.use_in_replenishment === false)
      out.push(`<i class="ms-pol ms-pol--off" title="Not offered or suggested in Branch Replenishment${
        r.replenishment_note || r.policy_note ? ' — ' + esc(r.replenishment_note || r.policy_note) : ''}">no branch</i>`);
    if (r.use_in_planning === false)
      out.push('<i class="ms-pol ms-pol--off" title="Out of Stock Planning: no projection, no alert, no buy suggestion">no planning</i>');
    if (r.use_in_gateway === false)
      out.push('<i class="ms-pol ms-pol--off" title="Gateway stock does not count as sendable for this SKU">no gateway</i>');
    // Quem foi configurado à mão ganha um ponto: é a diferença entre "ninguém
    // olhou" e "alguém decidiu que fica assim".
    if (r.policy_decided)
      out.push(`<i class="ms-pol ms-pol--set" title="Set by hand${r.settings_updated_by ? ' by ' + esc(r.settings_updated_by) : ''}${
        r.settings_updated_at ? ' on ' + esc(String(r.settings_updated_at).slice(0, 10)) : ''}">set</i>`);
    // A discordância com o Cin7, onde ela muda o comportamento.
    if (r.cin7_dead_we_alive && r.policy_decided)
      out.push('<i class="ms-pol ms-pol--vs" title="Cin7 says Deprecated; someone here said it is still usable — so it stays available in Branch Replenishment">vs Cin7</i>');
    return out.join('');
  };

  const flags = (r) => FLAGS.filter(([k]) => r[k])
    .map(([, t, tip]) => `<i class="ms-flag" title="${esc(tip)}">${t}</i>`).join('')
    + politica(r)
    + (r.bom_components
        ? `<i class="ms-bom" title="Assembled from ${r.bom_components} component${r.bom_components > 1 ? 's' : ''}${
            r.carton_qty_in_bom ? ` — and this is where its pack size of ${n0(r.bom_first_qty)} is recorded, since carton quantity is 0` : ''}">BOM ${r.bom_components}</i>`
        : '');

  const COLS = [
    ['SKU', 90], ['5DC', 62], ['Product', 210], ['Status', 78],
    ['SOH', 66], ['Main', 66], ['Locs', 46],
    ['Length', 74], ['Width', 74], ['Height', 74], ['CBM', 70], ['Vol/unit', 74],
    ['Carton', 74], ['Pallet', 82], ['Pickface', 96], ['Cost', 78], ['Supplier', 110],
  ];

  function render() {
    const head = '<thead><tr>' + COLS.map(([t, w]) =>
      `<th class="${/SKU|5DC|Product|Status|Pickface|Supplier/.test(t) ? 'txt' : 'num'}" style="width:${w}px">${t}</th>`).join('') + '</tr></thead>';
    const body = S.rows.map((r) => {
      const dep = r.status === 'Deprecated';
      return `<tr class="ms-row${dep ? ' is-dep' : ''}${r.status === 'Not in Cin7' ? ' is-file' : ''}" data-sku="${esc(r.sku_key)}">
        <td class="txt code">${esc(r.sku)}</td>
        <td class="txt">${esc(r.dc) || '<span class="ms-none">·</span>'}</td>
        <td class="txt" title="${esc(r.name)}">${esc(r.name)}</td>
        <td class="txt"><span class="ms-st st-${r.status.replace(/\W/g, '')}">${esc(r.status)}</span>${flags(r)}</td>
        <td class="num">${n0(r.soh_total)}</td>
        <td class="num">${n0(r.soh_main)}</td>
        <td class="num">${n0(r.locations)}</td>
        ${dual(r.cin7_length, r.file_length)}
        ${dual(r.cin7_width, r.file_width)}
        ${dual(r.cin7_height, r.file_height)}
        ${one(r.cbm, 'ms-file', 'CBM comes only from the product file — the ERP does not carry it', (v) => n2(v))}
        ${one(r.each_volume, 'ms-file', 'Volume per unit — product file only', (v) => n2(v))}
        ${dual(r.cin7_carton, r.file_carton, { fmt: n0 })}
        ${dual(r.pallet_rules, r.pallet_restock, { fmt: n0 })}
        ${dual(r.cin7_pick, r.restock_pickface || r.file_pick, { text: true, fmt: esc })}
        ${dual(r.cin7_cost, r.file_cost, { tol: 0.05, floor: 0.01 })}
        <td class="txt">${esc(r.file_supplier) || '<span class="ms-none">·</span>'}</td>
      </tr>`;
    }).join('');
    $('#msGrid').innerHTML = head + '<tbody>' + body + '</tbody>';
    $('#msGrid').querySelectorAll('tr.ms-row').forEach((tr) => tr.addEventListener('click', () => openSide(tr.dataset.sku)));
  }

  async function load(more) {
    S.offset = more ? S.offset + 300 : 0;
    const qs = new URLSearchParams({ limit: 300, offset: S.offset });
    if (S.q) qs.set('q', S.q);
    if (S.status) qs.set('status', S.status);
    if (S.gap) qs.set('gap', S.gap);
    if (S.conflict) qs.set('conflict', '1');
    $('#msCount').textContent = 'loading…';
    const d = await fetch(`/api/stock-planning/master-stock?${qs}`).then((r) => r.json());
    if (d.error) { $('#msCount').textContent = d.error; return; }
    S.rows = more ? S.rows.concat(d.rows) : d.rows;
    S.total = d.total; S.counts = d.counts;
    render();
    $('#msCount').textContent = `${n0(S.rows.length)} of ${n0(d.total)} · ${d.ms} ms`;
    $('#msMore').style.display = S.rows.length < d.total ? '' : 'none';
    paintChips(d.counts);
    $('#statusDot').className = 'sp-dot fresh';
    $('#statusText').textContent =
      `${n0(d.counts.total)} SKUs · ${n0(d.counts.active)} active · ${n0(d.counts.deprecated)} deprecated · ${n0(d.counts.file_only)} only in the file`;
  }

  // A contagem no chip é o que o torna útil: um filtro que devolve 0 ou tudo
  // não é filtro, e sem o número o usuário só descobre abrindo.
  function paintChips(c) {
    if (!c) return;
    const map = { dims: c.gap_dims, weight: c.gap_weight, carton: c.gap_carton, pallet: c.gap_pallet, pick: c.gap_pick,
      dimunit: c.flag_dimunit, packsku: c.flag_packsku, locator: c.flag_locator, stocknodim: c.flag_stocknodim,
      bom: c.flag_bom, cartonbad: c.flag_cartonbad,
      filedim: c.flag_filedim, voldefault: c.flag_voldefault, cube: c.flag_cube,
      decided: c.pol_decided, nobranch: c.pol_nobranch, noplan: c.pol_noplan, nogw: c.pol_nogw,
      disc: c.pol_disc, runout: c.pol_runout, cin7dead: c.pol_cin7dead, cin7live: c.pol_cin7live };
    document.querySelectorAll('[data-gap]').forEach((b) => {
      const n = map[b.dataset.gap];
      // A marca é explícita e não "o texto já tem dígito": o rótulo
      // "Carton SKU, qty 0" tem um dígito próprio e ficava sem contagem.
      if (n != null && !b.dataset.counted) { b.dataset.counted = '1'; b.textContent = `${b.textContent} (${n0(n)})`; }
      b.classList.toggle('is-on', S.gap === b.dataset.gap);
    });
    $('#msConflict').classList.toggle('is-on', S.conflict);
  }

  function openSide(key) {
    const r = S.rows.find((x) => x.sku_key === key); if (!r) return;
    const line = (label, cin7, file, extra) => `<tr><td>${esc(label)}</td>
      <td class="n">${cin7 == null || cin7 === '' ? '<span class="ms-none">·</span>' : esc(String(cin7))}</td>
      <td class="n">${file == null || file === '' ? '<span class="ms-none">·</span>' : esc(String(file))}</td>
      <td class="n">${extra == null || extra === '' ? '<span class="ms-none">·</span>' : esc(String(extra))}</td></tr>`;
    $('#sideTitle').textContent = r.sku;
    $('#sideBody').innerHTML = `
      <div class="rp-side-code">${esc(r.sku)}</div>
      <div class="rp-side-name">${esc(r.name || '')}</div>
      <div class="sp-panel" style="margin-top:14px">
        <h4>Where each value comes from <span>Cin7 · product file · Re-Stock</span></h4>
        <div class="in" style="padding:0"><table><thead><tr>
          <th>Field</th><th class="n">Cin7</th><th class="n">File</th><th class="n">Re-Stock</th>
        </tr></thead><tbody>
          ${line('Length', r.cin7_length, r.file_length)}
          ${line('Width', r.cin7_width, r.file_width)}
          ${line('Height', r.cin7_height, r.file_height)}
          ${line('CBM', null, r.cbm)}
          ${line('Volume / unit', null, r.each_volume)}
          ${line('Volume / carton', null, r.ctn_volume)}
          ${line('Carton qty', r.cin7_carton, r.file_carton, r.restock_carton)}
          ${line('Pallet qty', null, null, r.pallet_restock)}
          ${line('Pallet (rules)', null, null, r.pallet_rules)}
          ${line('Pickface', r.cin7_pick, r.file_pick, r.restock_pickface)}
          ${line('Pickface qty', null, null, r.restock_pickface_qty)}
          ${line('Avg cost', r.cin7_cost, r.file_cost)}
          ${line('Cost USD', null, r.cost_usd)}
          ${line('Freight each', null, r.freight_each)}
          ${line('Supplier', null, r.file_supplier)}
        </tbody></table></div>
      </div>
      <div class="sp-panel"><h4>Stock <span>live from Cin7</span></h4><div class="in">
        <b>${n0(r.soh_total)}</b> units across ${n0(r.locations)} location(s) · Main ${n0(r.soh_main)}</div></div>
      <div class="sp-panel"><h4>Where this row came from</h4><div class="in rp-sub">
        ${r.in_cin7 ? 'In Cin7' : '<b>Not in Cin7</b>'} ·
        ${r.in_file ? 'in the product file' : 'not in the product file'}
        ${r.source_sheets ? '<br>Sheets: ' + esc([].concat(r.source_sheets).join(', ')) : ''}</div></div>

      <!-- A política deste produto dentro do NOSSO sistema.
           Nada aqui é escrito no Cin7: é uma camada que diz como esta linha se
           comporta nas ferramentas de Inventory Management. Por isso ela pode
           discordar do ERP de propósito, e quando discorda a tela mostra os
           dois lados. -->
      <div class="sp-panel is-edit" id="msPolicy">
        <h4>How this product behaves here <span>our system only — never written to Cin7</span></h4>
        <div class="in"><div class="rp-sub">loading…</div></div>
      </div>`;
    $('#side').classList.add('is-on');
    carregarPolitica(key);
  }

  /* Os dois controles gravam.
     master.js era inteiramente de leitura — um único GET, sem api() e sem
     toast(), embora o HTML já declarasse um #toast que ninguém tocava. Estes
     dois são a primeira escrita da tela, e por isso trazem o cabeçalho de
     auditoria: sem ele a mudança fica atribuída a "planner" e ninguém sabe
     quem decidiu tirar um produto da reposição. */


  let avisoT;
  function aviso(msg, bad) {
    const el = $('#toast'); if (!el) return;
    el.textContent = msg;
    el.className = 'sp-toast is-on' + (bad ? ' bad' : '');
    clearTimeout(avisoT); avisoT = setTimeout(() => { el.className = 'sp-toast'; }, bad ? 5000 : 2000);
  }

  /* O painel de política: carrega, deixa editar, e só grava no Save.
     A versão anterior gravava a cada clique de checkbox — três decisões
     viravam três gravações, três linhas de auditoria, e nenhum instante em que
     desistir. Política é um conjunto e se grava como conjunto. */
  let polEstado = null, polSku = null;

  async function carregarPolitica(sku) {
    polSku = sku;
    const box = $('#msPolicy'); if (!box) return;
    try {
      const d = await (await fetch(`/api/stock-planning/sku-policy/${encodeURIComponent(sku)}`)).json();
      if (d.error) throw new Error(d.error);
      if (polSku !== sku) return;              // o usuário já abriu outra linha
      polEstado = { ...d.policy };
      pintarPolitica(d);
    } catch (e) {
      box.innerHTML = `<h4>How this product behaves here</h4>
        <div class="in rp-sub">Could not load: ${esc(e.message)}</div>`;
    }
  }

  const USOS = [
    ['use_in_replenishment', 'Branch Replenishment',
     'Can be suggested when a branch is restocked. Off means it never appears in the suggestions and cannot be typed in either.'],
    ['use_in_planning', 'Stock Planning',
     'Counts in the weekly projection and in the alerts. Off means it stops driving buy suggestions.'],
    ['use_in_gateway', 'Gateway',
     'Can be suggested for the Gateway warehouse.'],
  ];

  const CICLOS = [
    ['ACTIVE', 'Active', 'Bought and stocked normally.'],
    ['RUN_OUT', 'Run-out', 'Sell what is left, do not reorder. Still shows everywhere, flagged.'],
    ['DISCONTINUED', 'Discontinued',
     'Dead. It does NOT disappear from Stock Planning or Branch Replenishment — it shows there with a flag, so a decision on remaining stock is still possible.'],
  ];

  function pintarPolitica(d) {
    const p = polEstado, box = $('#msPolicy');
    // O desacordo com o Cin7 fica em cima, porque é o que muda a leitura de
    // tudo abaixo dele.
    const discorda = p.cin7_says_dead_we_say_alive
      ? `<p class="ms-disc">Cin7 has this <b>Deprecated</b>, and here it is still <b>Active</b>.
           Nothing is wrong with that — it just means someone should decide.</p>`
      : p.cin7_says_alive_we_say_dead
      ? `<p class="ms-disc">Cin7 still has this <b>Active</b>, and here it is <b>Discontinued</b>.
           Our call wins inside this system; Cin7 is untouched.</p>`
      : '';

    box.innerHTML = `<h4>How this product behaves here <span>our system only — never written to Cin7</span></h4>
      <div class="in">
        ${discorda}
        <div class="ms-cin7row">
          <span>Cin7 says</span>
          <b class="ms-c7 ${p.cin7_deprecated ? 'is-dep' : ''}">${esc(p.cin7_status || '—')}</b>
          <i>read-only, from the ERP</i>
        </div>

        <label class="ms-fl"><span>Lifecycle — our call</span>
          <select id="polLife">
            ${CICLOS.map(([v, r]) => `<option value="${v}"${p.lifecycle_status === v ? ' selected' : ''}>${r}</option>`).join('')}
          </select></label>
        <p class="ms-hint" id="polLifeHint">${esc((CICLOS.find((c) => c[0] === p.lifecycle_status) || CICLOS[0])[2])}</p>

        <div class="ms-uses">
          ${USOS.map(([k, rot, aj]) => `<label class="ms-sw" title="${esc(aj)}">
            <input type="checkbox" data-use="${k}"${p[k] ? ' checked' : ''}>
            <span>${rot}</span></label>
            <p class="ms-hint ms-hint-in">${esc(aj)}</p>`).join('')}
        </div>

        <label class="ms-fl"><span>Why</span>
          <input id="polNote" maxlength="200" placeholder="reason, so the next person knows"
                 value="${esc(p.policy_note || '')}"></label>

        <div class="ms-save">
          <button class="sp-btn is-primary" id="polSave" disabled>Save</button>
          <span class="ms-save-st" id="polSt">${p.settings_updated_at
            ? `last changed ${esc(dmy(p.settings_updated_at))} by ${esc(p.settings_updated_by || '—')}`
            : 'never configured — the defaults apply'}</span>
        </div>
      </div>

      <div class="in ms-hist">
        <h5>History</h5>
        ${d.historico.length
          ? `<ul>${d.historico.map((h) => `<li>
              <b>${esc(dmyTime(h.quando))}</b> · ${esc(h.quem)}
              <span>${h.campos.map((c) => `${esc(c.campo)}: ${esc(String(c.de ?? '—'))} → <b>${esc(String(c.para ?? '—'))}</b>`).join(' · ')}</span>
            </li>`).join('')}</ul>`
          : `<p class="rp-sub">No change recorded.<br>
             The audit only started writing on ${esc(d.historico_desde)} — before that a swallowed
             error left the log empty, so "nothing here" can also mean "changed earlier".</p>`}
      </div>`;
    ligarPolitica();
  }

  const dmy = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
  const dmyTime = (v) => { const d = dmy(v); const t = /T(\d{2}:\d{2})/.exec(String(v || '')); return d + (t ? ' ' + t[1] : ''); };

  function ligarPolitica() {
    const marcarSujo = () => {
      const b = $('#polSave'); if (!b) return;
      b.disabled = false; b.textContent = 'Save';
      $('#polSt').textContent = 'not saved yet';
    };
    const lf = $('#polLife');
    if (lf) lf.addEventListener('change', () => {
      const c = CICLOS.find((x) => x[0] === lf.value);
      if (c) $('#polLifeHint').textContent = c[2];
      marcarSujo();
    });
    document.querySelectorAll('#msPolicy [data-use]').forEach((c) => c.addEventListener('change', marcarSujo));
    const nt = $('#polNote'); if (nt) nt.addEventListener('input', marcarSujo);

    const sv = $('#polSave');
    if (sv) sv.addEventListener('click', async () => {
      if (sv.disabled) return;
      sv.disabled = true; sv.textContent = 'Saving…';
      const corpo = { lifecycle_status: $('#polLife').value, policy_note: $('#polNote').value.trim() || null };
      document.querySelectorAll('#msPolicy [data-use]').forEach((c) => { corpo[c.dataset.use] = c.checked; });
      try {
        const r = await fetch(`/api/stock-planning/sku-policy/${encodeURIComponent(polSku)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json',
                     'x-sp-user': localStorage.getItem('sp.who') || 'planner' },
          body: JSON.stringify(corpo),
        });
        const b = await r.json();
        if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
        // A grade em memória acompanha, senão a linha contradiz o painel até
        // alguém recarregar.
        const i = S.rows.findIndex((x) => x.sku_key === polSku);
        if (i >= 0) S.rows[i] = { ...S.rows[i], ...b, has_settings: true };
        render();
        aviso('Saved');
        await carregarPolitica(polSku);        // recarrega para o histórico aparecer
      } catch (e) {
        aviso('Not saved: ' + e.message, true);
        sv.disabled = false; sv.textContent = 'Save';
      }
    });
  }



  $('#msQ').addEventListener('input', debounce((e) => { S.q = e.target.value; load(); }));
  $('#msStatus').addEventListener('change', (e) => { S.status = e.target.value; load(); });
  document.querySelectorAll('[data-gap]').forEach((b) => b.addEventListener('click', () => {
    S.gap = S.gap === b.dataset.gap ? '' : b.dataset.gap; load();
  }));
  $('#msConflict').addEventListener('click', () => { S.conflict = !S.conflict; load(); });
  $('#msMore').addEventListener('click', () => load(true));
  $('#sideClose').addEventListener('click', () => $('#side').classList.remove('is-on'));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#side').classList.remove('is-on'); });

  load().catch((e) => { $('#statusText').textContent = 'Could not load: ' + e.message; });
})();
