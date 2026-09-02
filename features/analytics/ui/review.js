/**
 * Monthly Review · build board.
 *
 * Uma tela para o relatorio mensal sair do PowerPoint aos poucos: cada uma das
 * 54 analises com estado, nota, e — quando a fonte ja existe — o grafico ao
 * vivo com filtro, no lugar do print.
 *
 * O texto da tela e em INGLES como o resto do app; os comentarios em portugues,
 * que e a lingua de quem mantem isto.
 */
'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // O brief vem do catalogo com <b> e <code> que EU escrevi, e so esses. Escapo
  // tudo e devolvo apenas essas duas tags -- assim nota de usuario nunca vira
  // HTML, e o brief continua legivel.
  const briefHtml = (s) => esc(s)
    .replace(/&lt;b&gt;/g, '<b>').replace(/&lt;\/b&gt;/g, '</b>')
    .replace(/&lt;code&gt;/g, '<code>').replace(/&lt;\/code&gt;/g, '</code>');

  const ROTULO = { pronto: 'Ready to automate', parcial: 'Partial', manual: 'Manual' };

  // Qual analise ja tem grafico ao vivo. Cresce conforme as views nascem.
  const GRAFICO = {
    'jul-02': 'monthly-sales',
    'jul-18': 'monthly-sales',
    'jul-19': 'stock-by-warehouse',
    'master-01': 'monthly-sales',
  };

  const S = { rows: [], warning: null, charts: new Map(), cache: new Map() };

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, 2600);
  }

  const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-AU');

  // ── carregar ───────────────────────────────────────────────────────────
  async function carregar() {
    const r = await fetch('/api/review/board');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    S.rows = d.rows; S.warning = d.warning;
    if (d.warning) { $('warn').textContent = d.warning; $('warn').hidden = false; }
    $('state').textContent = d.total + ' analyses';
    pintar();
  }

  function progresso(vis) {
    const done = S.rows.filter((r) => r.status === 'done').length;
    const work = S.rows.filter((r) => r.status === 'working').length;
    const n = S.rows.length || 1;
    $('barDone').style.width = (100 * done / n) + '%';
    $('barWork').style.width = (100 * work / n) + '%';
    $('progTxt').textContent = `${done} done · ${work} working · ${n - done - work} to do`;
    $('count').textContent = vis === S.rows.length ? `${vis} shown` : `${vis} of ${S.rows.length} shown`;
  }

  // ── pintar a lista ─────────────────────────────────────────────────────
  function pintar() {
    const fd = $('fDeck').value, fr = $('fReady').value, fs = $('fStatus').value;
    const ft = $('fText').value.trim().toLowerCase();
    const vis = S.rows.filter((r) =>
      (!fd || r.deck === fd) && (!fr || r.readiness === fr) && (!fs || r.status === fs) &&
      (!ft || (r.title + ' ' + r.brief).toLowerCase().includes(ft)));

    S.charts.forEach((c) => c.destroy());
    S.charts.clear();

    const lista = $('list');
    if (!vis.length) { lista.innerHTML = '<p class="rv-empty">Nothing matches these filters.</p>'; progresso(0); return; }

    lista.innerHTML = vis.map((r) => {
      const quando = r.updated_at
        ? `<span class="rv-when">saved ${new Date(r.updated_at).toLocaleDateString('en-AU')}` +
          `${r.updated_by ? ' · ' + esc(r.updated_by) : ''}</span>` : '';
      const grafico = GRAFICO[r.key]
        ? `<div class="rv-chart" data-src="${GRAFICO[r.key]}" data-key="${r.key}">
             <div class="rv-chart-bar"><span class="rv-when">loading chart…</span></div>
             <div class="rv-canvas-wrap"><canvas id="cv-${r.key}"></canvas></div>
           </div>` : '';
      return `
      <article class="rv-card ${r.img ? '' : 'no-img'} ${r.status === 'done' ? 'is-done' : ''}" data-key="${r.key}">
        ${r.img ? `<img class="rv-thumb" loading="lazy" src="/features/analytics/ui/${esc(r.img)}" alt="">` : ''}
        <div>
          <div class="rv-head">
            <span class="rv-n">${r.deck === 'jul' ? 'JUL' : 'MST'} ${String(r.n).padStart(2, '0')}</span>
            <h3 class="rv-title">${esc(r.title)}</h3>
            <span class="rv-chip ${r.readiness}">${ROTULO[r.readiness]}</span>
          </div>
          <p class="rv-brief">${briefHtml(r.brief)}</p>
          ${grafico}
          <div class="rv-actions">
            ${['todo', 'working', 'done'].map((st) => `
              <button class="rv-btn ${r.status === st ? 'on ' + st : ''}" data-st="${st}">
                ${st === 'todo' ? 'To do' : st === 'working' ? 'Working' : 'Done'}
              </button>`).join('')}
            ${quando}
          </div>
          <textarea class="rv-note" rows="2"
            placeholder="Ideas, blockers, what still needs a feature…">${esc(r.note || '')}</textarea>
        </div>
      </article>`;
    }).join('');

    progresso(vis.length);
    lista.querySelectorAll('.rv-chart').forEach(montarGrafico);
  }

  // ── salvar ─────────────────────────────────────────────────────────────
  async function salvar(key, patch) {
    const r = S.rows.find((x) => x.key === key);
    if (!r) return;
    const corpo = { status: patch.status != null ? patch.status : r.status,
                    note: patch.note != null ? patch.note : r.note };
    const res = await fetch('/api/review/board/' + encodeURIComponent(key), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
    if (!res.ok) {
      // Falha aqui NAO pode passar despercebida: a pessoa escreveu uma ideia e
      // acha que guardou. Diz na tela e devolve o valor antigo.
      toast('Could not save — ' + (await res.text()).slice(0, 90));
      return false;
    }
    Object.assign(r, corpo, { updated_at: new Date().toISOString() });
    return true;
  }

  // ── graficos ───────────────────────────────────────────────────────────
  async function dados(src) {
    if (S.cache.has(src)) return S.cache.get(src);
    const p = fetch('/api/review/data/' + src).then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
    S.cache.set(src, p);
    return p;
  }

  async function montarGrafico(box) {
    const src = box.dataset.src, key = box.dataset.key;
    let d;
    try { d = await dados(src); }
    catch (e) {
      box.querySelector('.rv-chart-bar').innerHTML =
        `<span class="rv-when">chart unavailable — ${esc(e.message)}</span>`;
      return;
    }
    const bar = box.querySelector('.rv-chart-bar');

    if (src === 'monthly-sales') {
      const whs = [...new Set(d.rows.map((r) => r.wh))].sort();
      const anos = [...new Set(d.rows.map((r) => String(r.mth).slice(0, 4)))].sort().reverse();
      bar.innerHTML =
        `<select class="f-wh"><option value="">All warehouses</option>${
          whs.map((w) => `<option>${esc(w)}</option>`).join('')}</select>
         <select class="f-yr">${anos.map((a) => `<option>${a}</option>`).join('')}</select>
         <select class="f-me"><option value="sales">Sales</option>
           <option value="gross_profit">Gross profit</option>
           <option value="orders">Orders</option></select>
         <span class="rv-gap" style="flex:1"></span>
         <button class="rv-btn b-copy">Copy image</button>
         <button class="rv-btn b-png">Download PNG</button>`;
      const desenhar = () => {
        const wh = bar.querySelector('.f-wh').value;
        const yr = bar.querySelector('.f-yr').value;
        const me = bar.querySelector('.f-me').value;
        const f = d.rows.filter((r) => String(r.mth).slice(0, 4) === yr && (!wh || r.wh === wh));
        const meses = [...new Set(f.map((r) => String(r.mth).slice(0, 7)))].sort();
        const soma = meses.map((m) => f.filter((r) => String(r.mth).slice(0, 7) === m)
          .reduce((s, r) => s + (Number(r[me]) || 0), 0));
        render(key, box, {
          type: 'bar',
          data: { labels: meses, datasets: [{ label: `${me} · ${wh || 'all'} · ${yr}`, data: soma,
            backgroundColor: '#0d8fca', borderRadius: 3 }] },
          options: opcoes(me === 'orders' ? null : money),
        });
      };
      bar.querySelectorAll('select').forEach((s) => s.addEventListener('change', desenhar));
      ligarExport(bar, key, d.title);
      desenhar();
    }

    if (src === 'stock-by-warehouse') {
      const kinds = [...new Set(d.rows.map((r) => r.kind))].sort();
      bar.innerHTML =
        `<select class="f-kind"><option value="">All location kinds</option>${
          kinds.map((k) => `<option>${esc(k)}</option>`).join('')}</select>
         <select class="f-me"><option value="soh_value">Stock value</option>
           <option value="units">Units</option>
           <option value="months_stock">Months of cover</option></select>
         <span style="flex:1"></span>
         <button class="rv-btn b-copy">Copy image</button>
         <button class="rv-btn b-png">Download PNG</button>`;
      const desenhar = () => {
        const k = bar.querySelector('.f-kind').value;
        const me = bar.querySelector('.f-me').value;
        const f = d.rows.filter((r) => (!k || r.kind === k) && Number(r[me]))
          .sort((a, b) => Number(b[me]) - Number(a[me]));
        render(key, box, {
          type: 'bar',
          data: { labels: f.map((r) => r.wh), datasets: [{ label: me, data: f.map((r) => Number(r[me])),
            backgroundColor: '#0d8fca', borderRadius: 3 }] },
          options: opcoes(me === 'soh_value' ? money : null, 'y'),
        });
      };
      bar.querySelectorAll('select').forEach((s) => s.addEventListener('change', desenhar));
      ligarExport(bar, key, d.title);
      desenhar();
    }

    if (d.note) {
      const p = document.createElement('p');
      p.className = 'rv-note-src'; p.textContent = d.note;
      box.appendChild(p);
    }
  }

  function opcoes(fmt, eixo) {
    const t = (v) => (fmt ? fmt(v) : Number(v).toLocaleString('en-AU'));
    return {
      indexAxis: eixo === 'y' ? 'y' : 'x',
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false },
        tooltip: { callbacks: { label: (c) => ' ' + t(c.parsed[eixo === 'y' ? 'x' : 'y']) } } },
      scales: { x: { grid: { display: eixo === 'y' }, ticks: { font: { size: 11 } } },
                y: { grid: { color: '#e6ebf1' }, ticks: { font: { size: 11 },
                     callback: (v) => (eixo === 'y' ? v : t(v)) } } },
      // Fundo branco no canvas: sem isto a imagem copiada sai TRANSPARENTE e
      // fica ilegivel colada num slide de fundo escuro.
      backgroundColor: '#ffffff',
    };
  }

  function render(key, box, cfg) {
    const antigo = S.charts.get(key);
    if (antigo) antigo.destroy();
    const cv = box.querySelector('canvas');
    S.charts.set(key, new Chart(cv, cfg));
  }

  /** Copiar para a area de transferencia e baixar — para cair num slide. */
  function ligarExport(bar, key, titulo) {
    const comFundo = () => {
      const cv = S.charts.get(key).canvas;
      const out = document.createElement('canvas');
      out.width = cv.width; out.height = cv.height;
      const g = out.getContext('2d');
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, out.width, out.height);
      g.drawImage(cv, 0, 0);
      return out;
    };
    bar.querySelector('.b-png').addEventListener('click', () => {
      const a = document.createElement('a');
      a.download = `${key}-${titulo.replace(/[^\w]+/g, '-').toLowerCase()}.png`;
      a.href = comFundo().toDataURL('image/png');
      a.click();
      toast('PNG downloaded');
    });
    bar.querySelector('.b-copy').addEventListener('click', () => {
      comFundo().toBlob(async (b) => {
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]);
          toast('Chart copied — paste straight into the deck');
        } catch (e) {
          // Alguns navegadores so permitem colar imagem em contexto seguro.
          // Dizer o motivo e melhor do que um botao que nao faz nada.
          toast('Clipboard blocked by the browser — use Download PNG');
        }
      });
    });
  }

  // ── eventos ────────────────────────────────────────────────────────────
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('.rv-btn[data-st]');
    if (!b) return;
    const card = b.closest('.rv-card');
    const key = card.dataset.key, st = b.dataset.st;
    b.disabled = true;
    if (await salvar(key, { status: st })) { pintar(); toast('Saved'); }
    b.disabled = false;
  });

  document.addEventListener('change', async (e) => {
    if (!e.target.classList.contains('rv-note')) return;
    const key = e.target.closest('.rv-card').dataset.key;
    if (await salvar(key, { note: e.target.value })) toast('Note saved');
  });

  ['fDeck', 'fReady', 'fStatus'].forEach((id) => $(id).addEventListener('change', pintar));
  let t;
  $('fText').addEventListener('input', () => { clearTimeout(t); t = setTimeout(pintar, 180); });

  carregar().catch((e) => {
    $('list').innerHTML = `<p class="rv-empty">Could not load the board — ${esc(e.message)}</p>`;
    $('state').textContent = 'error';
  });
})();
