'use strict';
/* Monthly Review — o Inventory Report, gerado.
 *
 * A tela anterior era uma central de análises com quatro abas que eu inventei.
 * O relatório de verdade existe há sete meses, tem 33 slides numa ordem
 * estabelecida, e a reunião segue essa ordem. Então esta tela não corta nada:
 * reproduz o deck, bloco a bloco, do jeito que ele é.
 *
 * E mostra os blocos que AINDA NÃO TÊM DADO, com o motivo. Um relatório que
 * omite o que falta parece completo — e quem monta o deck continuaria
 * descobrindo o buraco na véspera da reunião, como descobre hoje.
 */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (v) => v == null ? '' : String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const n0 = (v) => (v == null || v === '' || isNaN(v)) ? '' : Math.round(Number(v)).toLocaleString('en-AU');
  const aud = (v) => (v == null || v === '' || isNaN(v)) ? '' : 'A$' + Math.round(Number(v)).toLocaleString('en-AU');

  /* Dinheiro e contagem se formatam diferente, e a tabela não sabe qual é
     qual. A heurística é o nome da coluna — imperfeita de propósito: errar o
     cifrão é feio, inventar uma declaração de tipo por coluna em 12 tabelas
     seria pior. */
  const ehDinheiro = (col) => /valor|venda|custo|\$|cost|value/i.test(col);
  const ehNumero = (col) => /qty|unidades|pedidos|linhas|skus|dias|meses|%|coletados|sem fatura/i.test(col);

  function celula(v, col) {
    if (v == null || v === '') return '<td class="n">—</td>';
    if (typeof v === 'number' || /^-?[\d.]+$/.test(String(v))) {
      if (ehDinheiro(col)) return `<td class="n">${aud(v)}</td>`;
      if (ehNumero(col)) return `<td class="n">${n0(v)}</td>`;
    }
    if (ehDinheiro(col) || ehNumero(col)) return `<td class="n">${esc(v)}</td>`;
    return `<td>${esc(v)}</td>`;
  }

  const tabela = (t) => `<table class="dk-tbl">
    ${t.titulo ? `<caption>${esc(t.titulo)}</caption>` : ''}
    <thead><tr>${t.cols.map((c) => `<th class="${ehDinheiro(c) || ehNumero(c) ? 'n' : ''}">${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${t.linhas.map((l) => `<tr>${l.map((v, i) => celula(v, t.cols[i])).join('')}</tr>`).join('')}</tbody>
  </table>`;

  const kpi = (k) => `<div class="dk-kpi">
    <b>${k.formato === 'int' ? n0(k.valor) : k.formato === 'pct' ? (k.valor == null ? '—' : k.valor + '%') : aud(k.valor)}</b>
    <span>${esc(k.rotulo)}</span>${k.sub ? `<i>${esc(k.sub)}</i>` : ''}</div>`;

  function serie(s) {
    const max = Math.max(...s.pontos.map((p) => p.y), 1);
    return `<div class="dk-serie">${s.pontos.map((p) => `<div class="dk-bar">
      <b>${n0(p.y)}</b><i style="height:${Math.round(58 * p.y / max)}px"></i>
      <span>${esc(String(p.x).slice(5))}</span></div>`).join('')}</div>`;
  }

  function bloco(b) {
    const vazio = b.estado !== 'PRONTO';
    const corpo = vazio ? '' : `<div class="dk-body">
      ${b.aviso ? `<p class="dk-nota dk-aviso">${esc(b.aviso)}</p>` : ''}
      ${b.nota ? `<p class="dk-nota">${esc(b.nota)}</p>` : ''}
      ${b.kpis ? `<div class="dk-kpis">${b.kpis.map(kpi).join('')}</div>` : ''}
      ${b.kpi ? `<div class="dk-kpis">${kpi(b.kpi)}</div>` : ''}
      ${b.serie ? serie(b.serie) : ''}
      ${(b.tabelas || []).map(tabela).join('')}
    </div>`;
    return `<div class="dk-block${vazio ? ' is-vazio' : ''}">
      <div class="dk-head">
        <span class="dk-n">${esc(b.n)}</span>
        <span class="dk-tit">${esc(b.titulo)}</span>
        <span class="dk-st ${esc(b.estado)}">${esc(b.estado)}</span>
      </div>
      ${vazio && b.nota ? `<div class="dk-body"><p class="dk-nota">${esc(b.nota)}</p></div>` : corpo}
    </div>`;
  }

  async function carregar(mes) {
    $('#dkBody').innerHTML = '<div class="sp-loading">Montando o relatório…</div>';
    try {
      const r = await fetch('/api/analytics/deck' + (mes ? `?month=${mes}` : ''));
      const d = await r.json();
      if (d.error) throw new Error(d.error);

      const c = d.contagem;
      const tot = Object.values(c).reduce((a, b) => a + b, 0);
      $('#dkIntro').innerHTML = `
        Este é o <b>Inventory Report de ${esc(d.mes.rotulo)}</b>, na ordem do deck.
        Dos ${tot} blocos, <b>${c.PRONTO || 0}</b> saem do banco agora.
        Todo valor é <b>ex-GST</b> — o próprio deck usa as duas réguas em tabelas
        diferentes, e a de receita é sem imposto.
        <div class="dk-counts">
          ${['PRONTO', 'CONECTAR', 'CONSTRUIR', 'MANUAL'].filter((k) => c[k])
            .map((k) => `<span class="dk-st ${k}">${k} ${c[k]}</span>`).join('')}
        </div>`;
      $('#dkKey').innerHTML = ['PRONTO', 'CONECTAR', 'CONSTRUIR', 'MANUAL']
        .map((k) => `<span class="dk-st ${k}">${k}</span>`).join('');
      $('#dkBody').innerHTML = d.blocos.map(bloco).join('');
      $('#dkStatus').textContent = `${d.ms} ms`;
      $('#dkDot').className = 'sp-dot fresh';
    } catch (e) {
      $('#dkBody').innerHTML = `<div class="sp-empty">Não deu para montar o relatório.<br>
        <span class="rp-sub">${esc(e.message)}</span></div>`;
      $('#dkDot').className = 'sp-dot dead';
      $('#dkStatus').textContent = 'erro';
    }
  }

  // Os últimos 13 meses. O padrão é o último mês FECHADO, que é o que a
  // reunião discute — o mês corrente ainda está andando.
  (function meses() {
    const sel = $('#dkMes'); const hoje = new Date(); const opts = [];
    for (let i = 1; i <= 13; i++) {
      const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
      const v = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      opts.push(`<option value="${v}">${d.toLocaleString('en-AU', { month: 'long', year: 'numeric' })}</option>`);
    }
    sel.innerHTML = opts.join('');
    sel.addEventListener('change', () => carregar(sel.value));
    carregar(sel.value);
  })();
})();
