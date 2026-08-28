'use strict';
/* Núcleo compartilhado do Stock Planning.

   Este arquivo existe porque Projects e Purchase Orders saíram de dentro do
   planning.js para páginas próprias, e havia uma camada que as três precisam:
   o cliente de API com o cabeçalho de auditoria, os formatadores, o painel
   lateral, o toast e o editor de célula. Duplicá-la em três lugares faria
   três verdades divergirem — e a primeira a divergir seria a de formato de
   data, que já foi padronizada uma vez neste projeto.

   Carregado ANTES do script da página em todas elas. Não conhece view
   nenhuma: qualquer coisa específica de uma tela não pertence aqui.

   Sem módulos ES de propósito: as três páginas usam <script src> simples e
   todo o resto do repo também. */

const API = '/api/stock-planning';
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* Liga um listener SÓ se o elemento existe.

   O planning.js tem cerca de 55 chamadas `$('#x').addEventListener` no topo do
   arquivo, sem verificação. Numa página onde `#x` não existe — e é exatamente
   isso que separar as telas cria — a primeira delas lança TypeError e ABORTA o
   resto do arquivo. A página abre em branco, sem nada renderizado, e o erro
   aponta para um listener que não tem relação com o que quebrou.

   Toda ligação nas páginas novas passa por aqui. */
const on = (sel, ev, fn, opts) => { const el = typeof sel === 'string' ? $(sel) : sel;
  if (el) el.addEventListener(ev, fn, opts); return el; };


/* ── utilidades ─────────────────────────────────────────────────────── */
async function api(path, opts = {}) {
  const r = await fetch(API + path, { ...opts,
    headers: { 'Content-Type':'application/json', 'x-sp-user': localStorage.getItem('sp.who') || 'planner', ...(opts.headers||{}) } });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
  return b;
}
const esc = v => v==null ? '' : String(v).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const n0  = v => (v==null||v==='') ? '' : Math.round(Number(v)).toLocaleString('en-AU');
/* Zero não é informação. O Excel deixa a célula vazia, e uma coluna de zeros
   compete visualmente com os números que importam. */
const nz0 = v => (v==null||v===''||Number(v)===0) ? '' : Math.round(Number(v)).toLocaleString('en-AU');
const n1  = v => (v==null||v==='') ? '' : Number(v).toLocaleString('en-AU',{maximumFractionDigits:1});
const aud = v => (v==null||v==='') ? '' : 'A$' + Math.round(Number(v)).toLocaleString('en-AU');
const usd = v => (v==null||v==='') ? '' : '$' + Number(v).toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2});

/** dd/mm/yyyy — o padrão do app (features/returns/returns.js:20). */
const d10 = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso||'')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
const dSh = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso||'')); return m ? `${m[3]}/${m[2]}` : ''; };
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** Aceita dd/mm/yyyy, yyyy-mm-dd e "8 Nov 26". Devolve sempre ISO. */
function parseDate(v) {
  const s = String(v||'').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (m) return s;
  m = s.match(/^(\d{1,2})[\/\-. ](\d{1,2})[\/\-. ](\d{2,4})$/);
  if (m) { const y = m[3].length===2 ? '20'+m[3] : m[3]; return `${y}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`; }
  m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[a-z]*[\s-]?(\d{2,4})?$/);
  if (m) { const i = MON.findIndex(x => x.toLowerCase()===m[2].toLowerCase()); if (i<0) return null;
    const y = !m[3] ? String(new Date().getFullYear()) : (m[3].length===2 ? '20'+m[3] : m[3]);
    return `${y}-${String(i+1).padStart(2,'0')}-${m[1].padStart(2,'0')}`; }
  return null;
}

let toastT;
function toast(msg, bad) {
  const el = $('#toast'); el.textContent = msg;
  el.className = 'sp-toast is-on' + (bad ? ' bad' : '');
  clearTimeout(toastT); toastT = setTimeout(() => el.className = 'sp-toast', bad ? 5000 : 2400);
}
const debounce = (fn, ms=260) => { let t; return (...a) => { clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; };

/* ── painel lateral, modais, Escape ──────────────────────────────────── */
function side(title, html) { $('#sideTitle').textContent = title; $('#sideBody').innerHTML = html; $('#side').classList.add('is-on'); }
$('#sideClose').addEventListener('click', () => $('#side').classList.remove('is-on'));
document.addEventListener('keydown', e => { if (e.key !== 'Escape') return;
  $('#side').classList.remove('is-on'); $$('.sp-modal.is-on').forEach(m => m.classList.remove('is-on')); });
$$('.sp-modal').forEach(m => m.addEventListener('click', e => {
  if (e.target === m || e.target.hasAttribute('data-close')) m.classList.remove('is-on'); }));


/* ── edição inline ──────────────────────────────────────────────────── */
const before = new WeakMap();
document.addEventListener('focusin', e => { const c = e.target.closest('.sp-cell'); if (c) before.set(c, c.textContent); });
document.addEventListener('keydown', e => {
  const c = e.target.closest('.sp-cell'); if (!c) return;
  if (e.key === 'Enter') { e.preventDefault(); c.blur(); }
  else if (e.key === 'Escape') { e.preventDefault(); c.textContent = before.get(c)||''; c.dataset.skip='1'; c.blur(); }
  else if (e.key === 'Tab') {
    const cells = $$('.sp-cell', c.closest('tbody')||document);
    const i = cells.indexOf(c) + (e.shiftKey ? -1 : 1);
    if (cells[i]) { e.preventDefault(); c.blur(); cells[i].focus(); }
  }
});
document.addEventListener('focusout', async e => {
  const c = e.target.closest('.sp-cell'); if (!c) return;
  if (c.dataset.skip) { delete c.dataset.skip; return; }
  const was = before.get(c); const now = c.textContent.trim();
  if (was === undefined || now === was.trim()) return;
  const field = c.dataset.field;
  let value = now;
  if (c.dataset.kind === 'num')  value = now === '' ? 0 : Number(now.replace(/[^0-9.-]/g,''));
  if (c.dataset.kind === 'date') value = parseDate(now);
  if (c.dataset.kind === 'num' && isNaN(value)) { c.classList.add('bad'); return toast('Not a number', true); }
  if (c.dataset.kind === 'date' && now && !value) { c.classList.add('bad'); return toast('Use dd/mm/yyyy', true); }
  c.classList.add('busy');
  try {
    /* Três destinos, escolhidos pelo data-* que a célula carrega. As três
       páginas usam este mesmo editor, e por isso a rota tem que ser decidida
       aqui e não por quem montou a tabela. */
    const t = c.dataset.line ? `/lines/${c.dataset.line}`
            : c.dataset.po   ? `/po-lines/${c.dataset.po}`
            : `/skus/${encodeURIComponent(c.dataset.sku)}`;
    const upd = await api(t, { method:'PATCH', body: JSON.stringify({ [field]: value }) });
    c.classList.replace('busy','ok'); setTimeout(()=>c.classList.remove('ok'), 1000);
    before.set(c, c.textContent);
    /* O editor é do documento e serve as três páginas, mas o que fazer DEPOIS
       de gravar é de cada uma: Projects precisa remendar a linha em memória e
       redesenhar; Purchase Orders não precisa de nada. Um gancho em vez de um
       `if` por página mantém este arquivo sem saber quem o carregou. */
    if (window.SP_ON_SAVED) window.SP_ON_SAVED(c, upd);
  } catch (err) {
    c.classList.replace('busy','bad'); c.textContent = was;
    toast('Not saved: ' + err.message, true); setTimeout(()=>c.classList.remove('bad'), 2500);
  }
});
