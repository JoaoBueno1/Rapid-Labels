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
    ['flag_carton_name_mismatch', 'name≠BOM', 'The number in the SKU name and the quantity in the BOM disagree — one of the two is wrong'],
    ['flag_locator_junk', 'loc?', 'Stock locator is not a bin: it is "0" or a process word like BOM or PRODUCTION'],
  ];
  const flags = (r) => FLAGS.filter(([k]) => r[k])
    .map(([, t, tip]) => `<i class="ms-flag" title="${esc(tip)}">${t}</i>`).join('')
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
      bom: c.flag_bom, cartonbad: c.flag_cartonbad };
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
        ${r.source_sheets ? '<br>Sheets: ' + esc([].concat(r.source_sheets).join(', ')) : ''}</div></div>`;
    $('#side').classList.add('is-on');
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
