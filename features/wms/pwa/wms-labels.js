/* Rapid WMS — mobile extras: Labels + Container Check capture.
 *
 * Um arquivo separado de propósito. wms-app.js é o fluxo de picking e não deve
 * engordar por causa de etiquetas; este publica window.WmsExtra e o host o
 * monta se estiver presente — se este arquivo faltar, o WMS abre igual.
 *
 * O QUE NÃO ESTÁ AQUI, e por quê:
 *
 *   ZPL. O repo tem getZebraConfig/buildZpl3Up/sendZplToPrinter em app.js com
 *   ZERO chamadas (conferido) e /api/print-zpl abre um socket TCP para
 *   127.0.0.1:9100 — inalcançável de uma lambda. Nenhum módulo de etiqueta
 *   jamais emitiu ZPL: eles fazem PDF. Este segue PDF.
 *
 *   Uma segunda implementação de etiqueta. O desenho já existe como código
 *   vetorial em features/label-sheets/label-render.js (layoutBigLabel para a
 *   etiqueta grande, layoutMultiTable para a tabela) com as medidas já
 *   afinadas na impressora. Reescrever "para o celular" faria a etiqueta do
 *   telefone divergir da do desktop no dia em que alguém ajustasse uma das
 *   duas. Aqui só se monta o `cell` e se pede o PDF.
 *
 *   app.js e multi-label.js. Além de acoplados a ids de modal do desktop, o
 *   app.js instala um keydown global que desreferencia #searchModal sem guarda
 *   — dentro do PWA, um Escape derrubaria a tela.
 */
(function () {
  'use strict';

  // ── A INVERSÃO DE NOMES, escrita uma vez ────────────────────────────────
  // O que a empresa chama de "SKU" na tela é products.attribute1 (o 5DC), e o
  // que ela chama de "Code" é products.sku. É a origem mais provável de uma
  // etiqueta errada, então a tradução mora num lugar só e tem nome.
  function toCell(p, qty, date) {
    return { type: 'biglabel',
      dc5:  p.dc5 || '',      // UI "SKU"   = products.attribute1
      code: p.code || '',     // UI "Code"  = products.sku  → vira o CODE128
      qty:  qty || '',
      date: date || '' };
  }
  function toRow(p, qty) {
    return { dc5: p.dc5 || '', sku: p.code || '', barcode: p.barcode || '', qty: qty || '' };
  }

  var MAX_ML = 8;             // = ML_CONFIGS['A4-portrait'].maxSlots, em label-render.js
  var MAX_PHOTOS = 4;         // = MAX_PHOTOS do container-check

  // ── Motor de etiqueta, carregado só quando alguém abre uma tela de etiqueta ──
  // wms.html tem um script só e o operador que veio picar não deve baixar o
  // jsPDF. Ordem importa: JsBarcode antes do render (barcodeVector devolve null
  // sem ele — foi assim que uma folha saiu sem barras), templates antes do
  // render. Caminhos ABSOLUTOS: /wms é uma pasta montada, e caminho relativo
  // resolve diferente no Express e na Vercel.
  var ENGINE = [
    'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js',
    'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js',
    '/features/label-sheets/label-templates.js',
    '/features/label-sheets/label-render.js'
  ];
  var engineState = 0;        // 0 = não carregado, 1 = carregando, 2 = pronto
  var engineWaiting = [];
  function engineReady() {
    return typeof window.JsBarcode !== 'undefined' && window.jspdf && window.jspdf.jsPDF
        && window.LabelTemplates && window.LabelRender;
  }
  function loadEngine(cb) {
    if (engineState === 2 || engineReady()) { engineState = 2; return cb(null); }
    engineWaiting.push(cb);
    if (engineState === 1) return;
    engineState = 1;
    var i = 0;
    (function next() {
      if (i >= ENGINE.length) {
        // Falhar ALTO. O modo silencioso deste motor é devolver uma etiqueta sem
        // código de barras, que só se descobre no chão do armazém.
        var err = engineReady() ? null : new Error('label engine did not load');
        engineState = err ? 0 : 2;
        var q = engineWaiting; engineWaiting = [];
        for (var k = 0; k < q.length; k++) q[k](err);
        return;
      }
      var s = document.createElement('script');
      s.src = ENGINE[i++];
      s.onload = next;
      s.onerror = function () {
        engineState = 0;
        var q = engineWaiting; engineWaiting = [];
        for (var k = 0; k < q.length; k++) q[k](new Error('could not load ' + s.src));
      };
      document.head.appendChild(s);
    })();
  }

  // ── Entregar o PDF no telefone ──────────────────────────────────────────
  // Nunca bloburl + window.open: o iOS bloqueia, e é o que deixa o operador
  // preso numa aba em branco. Share Sheet quando existe (manda direto para a
  // impressora, AirPrint, WhatsApp), download quando não.
  function deliverPdf(doc, filename, toast) {
    var blob = doc.output('blob');
    var file = null;
    try { file = new File([blob], filename, { type: 'application/pdf' }); } catch (e) { file = null; }
    if (file && navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
      navigator.share({ files: [file], title: filename }).then(function () {
        toast('Sent', 'ok');
      }).catch(function (e) {
        // Cancelar o Share Sheet não é erro — não vale um toast vermelho.
        if (e && e.name === 'AbortError') return;
        doc.save(filename); toast('Saved to your files', 'ok');
      });
      return;
    }
    doc.save(filename);
    toast('Saved to your files', 'ok');
  }

  function today() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function dmy(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    return m ? (m[3] + '/' + m[2] + '/' + m[1]) : '';
  }

  // ═══════════════════════════════════════════════════════════════════════
  window.WmsExtra = {
    install: function (H) {
      var $ = H.$, esc = H.esc, go = H.go, toast = H.toast, bottom = H.bottom;

      // O api() do host é fixo em /api/wms; o Container Check vive em
      // /api/container-check, então precisa de um fetch próprio.
      function raw(method, url, body, headers) {
        var o = { method: method, headers: headers || {} };
        if (body != null) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
        return fetch(url, o).then(function (r) {
          return r.text().then(function (t) {
            var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
            if (!r.ok) throw new Error((j && (j.error || j.message)) || ('HTTP ' + r.status));
            return j;
          });
        });
      }

      function searchProducts(q) {
        return raw('GET', '/api/wms/product-search?q=' + encodeURIComponent(q));
      }

      // Uma tela de erro de verdade, em vez de um toast que some.
      function engineError(view, e, retry) {
        view.innerHTML = '<div class="banner err"><b>The label engine did not load.</b><br>' +
          esc((e && e.message) || 'unknown') +
          '<br><br>Labels need the network the first time. Check the connection and try again.</div>' +
          '<button class="btn" id="labRetry">Try again</button>';
        $('labRetry').onclick = retry;
      }

      // ── lista de resultados, compartilhada por Search & Print e Multi ────
      function resultList(items, onPick) {
        if (!items.length) return '<div class="empty">Nothing matched.</div>';
        var h = '<div class="lab-list">';
        for (var i = 0; i < items.length; i++) {
          var p = items[i];
          h += '<button class="lab-item" data-i="' + i + '">' +
                 '<div class="lab-dc5">' + esc(p.dc5 || '—') + '</div>' +
                 '<div class="lab-mid"><div class="lab-code">' + esc(p.code) + '</div>' +
                 '<div class="lab-name">' + esc(p.name || '') + '</div></div>' +
                 (p.barcode ? '<div class="lab-bc">bc</div>' : '') +
               '</button>';
        }
        return h + '</div>';
      }
      function wireResults(view, items, onPick) {
        var b = view.querySelectorAll('.lab-item');
        for (var i = 0; i < b.length; i++) {
          (function (el) { el.onclick = function () { onPick(items[+el.getAttribute('data-i')]); }; })(b[i]);
        }
      }

      // ═══ 1. MENU DE ETIQUETAS ═══════════════════════════════════════════
      function labelsScreen(view) {
        view.innerHTML =
          '<p class="eyebrow">Labels</p>' +
          '<div class="tiles">' +
            '<button class="tile" id="lSearch"><div class="t">Search &amp; Print</div><div class="s">Find a product and make its A4 label</div></button>' +
            '<button class="tile" id="lCustom"><div class="t">Custom Label</div><div class="s">Type the numbers yourself</div></button>' +
            '<button class="tile" id="lMulti"><div class="t">Multi-Label</div><div class="s">Up to ' + MAX_ML + ' products on one A4 sheet</div></button>' +
          '</div>' +
          '<div class="meta" style="margin-top:18px">The sheet is a PDF. Your phone opens the print dialog, or you can share it.</div>';
        $('lSearch').onclick = function () { go('labSearch', 'Search & Print'); };
        $('lCustom').onclick = function () { go('labMake', 'Custom Label', { custom: true }); };
        $('lMulti').onclick  = function () { go('labMulti', 'Multi-Label'); };
      }

      // ═══ 2. SEARCH & PRINT — achar o produto ════════════════════════════
      function labSearchScreen(view, ctx) {
        view.innerHTML =
          '<p class="eyebrow">Search &amp; Print</p>' +
          '<div class="banner">Scan the barcode, or type a <b>5DC</b>, a <b>code</b> or part of the name.</div>' +
          H.scanField('Scan or type…') +
          '<div id="labResults"></div>';
        H.wireScan(function (v) {
          if (!v || v.length < 2) return;
          $('labResults').innerHTML = '<div class="empty"><span class="spin"></span></div>';
          searchProducts(v).then(function (items) {
            // Um único acerto exato é o caso do leitor de código de barras:
            // parar para escolher entre uma opção só é atrito puro.
            if (items.length === 1 && items[0].matchedBy !== 'partial') {
              go('labMake', 'Label', { p: items[0] }); return;
            }
            $('labResults').innerHTML = resultList(items);
            wireResults(view, items, function (p) { go('labMake', 'Label', { p: p }); });
          }).catch(function (e) {
            $('labResults').innerHTML = '<div class="banner err">' + esc(e.message) + '</div>';
          });
        });
      }

      // ═══ 3. A ETIQUETA — um produto, A4 paisagem ════════════════════════
      // Serve ao Search & Print (com produto) e ao Custom Label (em branco).
      function labMakeScreen(view, ctx) {
        var p = (ctx && ctx.p) || { dc5: '', code: '', name: '', barcode: '' };
        var custom = !!(ctx && ctx.custom);
        view.innerHTML =
          '<p class="eyebrow">' + (custom ? 'Custom label' : esc(p.name || 'Label')) + '</p>' +
          '<label class="lab-f"><span>SKU <i>(5DC)</i></span>' +
            '<input id="fDc5" inputmode="numeric" value="' + esc(p.dc5 || '') + '" placeholder="5 digits"></label>' +
          '<label class="lab-f"><span>Code <i>(becomes the barcode)</i></span>' +
            '<input id="fCode" value="' + esc(p.code || '') + '" placeholder="Rapid code"></label>' +
          '<div class="lab-two">' +
            '<label class="lab-f"><span>Qty</span><input id="fQty" inputmode="numeric" placeholder="—"></label>' +
            '<label class="lab-f"><span>Date</span><input id="fDate" type="date" value="' + today() + '"></label>' +
          '</div>' +
          '<div class="meta" id="labWarn"></div>';
        bottom('<button class="btn" id="labGo">Create the label</button>');

        // 5DC de 5 dígitos é a regra da casa; forçar aqui evita a etiqueta com
        // 4 dígitos que ninguém percebe até o papel sair.
        $('fDc5').addEventListener('blur', function () {
          var v = String(this.value || '').replace(/\D/g, '');
          if (v && v.length < 5) v = ('00000' + v).slice(-5);
          this.value = v.slice(0, 5);
        });
        $('fCode').addEventListener('blur', function () { this.value = String(this.value || '').trim().toUpperCase(); });

        $('labGo').onclick = function () {
          var dc5 = $('fDc5').value.trim(), code = $('fCode').value.trim().toUpperCase();
          if (!dc5 && !code) { toast('Fill the SKU or the Code', 'err'); return; }
          if (!code) { toast('The Code makes the barcode — fill it', 'err'); return; }
          var btn = this; btn.disabled = true; btn.textContent = 'Building…';
          loadEngine(function (err) {
            btn.disabled = false; btn.textContent = 'Create the label';
            if (err) return engineError(view, err, function () { go('labMake', 'Label', ctx); });
            try {
              var T = window.LabelTemplates.byId('a4label');
              var doc = new window.jspdf.jsPDF({ unit: 'mm', format: [T.pageW, T.pageH],
                                                 orientation: 'landscape', compress: true });
              var cell = toCell({ dc5: dc5, code: code }, $('fQty').value.trim(), dmy($('fDate').value));
              window.LabelRender.toPdf(doc, cell, T.marginLeft, T.marginTop, T.labelW, T.labelH, {});
              deliverPdf(doc, 'label-' + (code || dc5) + '.pdf', toast);
            } catch (e) { toast('Could not build it: ' + e.message, 'err'); }
          });
        };
      }

      // ═══ 4. MULTI-LABEL — até 8 produtos numa folha ═════════════════════
      var ml = [];   // vive fora da tela: render() repinta e limparia a lista
      function labMultiScreen(view) {
        var h = '<p class="eyebrow">Multi-Label</p>' +
          '<div class="banner">Add up to <b>' + MAX_ML + '</b> products. Scan or type, then set the quantity.</div>' +
          H.scanField('Scan or type to add…') + '<div id="labResults"></div>';
        h += '<div class="lab-batch" id="mlBatch"></div>';
        view.innerHTML = h;
        paintBatch();
        H.wireScan(function (v) {
          if (!v || v.length < 2) return;
          if (ml.length >= MAX_ML) { toast('The sheet holds ' + MAX_ML, 'err'); return; }
          $('labResults').innerHTML = '<div class="empty"><span class="spin"></span></div>';
          searchProducts(v).then(function (items) {
            if (items.length === 1 && items[0].matchedBy !== 'partial') { add(items[0]); return; }
            $('labResults').innerHTML = resultList(items);
            wireResults(view, items, add);
          }).catch(function (e) {
            $('labResults').innerHTML = '<div class="banner err">' + esc(e.message) + '</div>';
          });
        });

        function add(p) {
          var k = String(p.code).toUpperCase();
          for (var i = 0; i < ml.length; i++) {
            // Já na folha: soma em vez de repetir a linha. Duas linhas do mesmo
            // produto gastam um dos oito lugares e confundem quem separa.
            if (String(ml[i].p.code).toUpperCase() === k) {
              ml[i].qty = String((parseInt(ml[i].qty, 10) || 0) + 1);
              $('labResults').innerHTML = ''; paintBatch();
              toast(p.code + ' already there — quantity +1'); return;
            }
          }
          ml.push({ p: p, qty: '' });
          $('labResults').innerHTML = '';
          paintBatch();
        }
        function paintBatch() {
          var el = $('mlBatch'); if (!el) return;
          if (!ml.length) { el.innerHTML = '<div class="empty">Nothing on the sheet yet.</div>'; bottom('');
            var bb = $('bottomBar'); if (bb) bb.classList.add('hidden'); return; }
          var s = '<div class="lab-bhead">' + ml.length + ' of ' + MAX_ML + ' on the sheet</div>';
          for (var i = 0; i < ml.length; i++) {
            s += '<div class="lab-brow">' +
                   '<div class="lab-dc5">' + esc(ml[i].p.dc5 || '—') + '</div>' +
                   '<div class="lab-mid"><div class="lab-code">' + esc(ml[i].p.code) + '</div>' +
                   '<div class="lab-name">' + esc(ml[i].p.name || '') + '</div></div>' +
                   '<input class="lab-q" data-i="' + i + '" inputmode="numeric" value="' + esc(ml[i].qty) + '" placeholder="Qty">' +
                   '<button class="lab-x" data-x="' + i + '" aria-label="Remove">&times;</button>' +
                 '</div>';
          }
          el.innerHTML = s;
          var qs = el.querySelectorAll('.lab-q');
          for (var a = 0; a < qs.length; a++) {
            (function (inp) {
              inp.oninput = function () { ml[+inp.getAttribute('data-i')].qty = inp.value.replace(/\D/g, ''); };
            })(qs[a]);
          }
          var xs = el.querySelectorAll('.lab-x');
          for (var b = 0; b < xs.length; b++) {
            (function (btn) {
              btn.onclick = function () { ml.splice(+btn.getAttribute('data-x'), 1); paintBatch(); };
            })(xs[b]);
          }
          bottom('<button class="btn ghost" id="mlClear">Clear</button>' +
                 '<button class="btn" id="mlGo">Create the sheet</button>');
          $('mlClear').onclick = function () { ml = []; paintBatch(); };
          $('mlGo').onclick = function () {
            var btn = this; btn.disabled = true; btn.textContent = 'Building…';
            loadEngine(function (err) {
              btn.disabled = false; btn.textContent = 'Create the sheet';
              if (err) return engineError(view, err, function () { go('labMulti', 'Multi-Label'); });
              try {
                var T = window.LabelTemplates.byId('multiA4P');
                var doc = new window.jspdf.jsPDF({ unit: 'mm', format: [T.pageW, T.pageH],
                                                   orientation: 'portrait', compress: true });
                var rows = [];
                for (var i = 0; i < ml.length; i++) rows.push(toRow(ml[i].p, ml[i].qty));
                var cell = { type: 'multitable', rows: rows, date: dmy(today()) };
                window.LabelRender.toPdf(doc, cell, T.marginLeft, T.marginTop, T.labelW, T.labelH,
                                         { mlConfig: T.mlConfig || 'A4-portrait' });
                deliverPdf(doc, 'multi-label.pdf', toast);
              } catch (e) { toast('Could not build it: ' + e.message, 'err'); }
            });
          };
        }
      }

      // ═══ 5. CONTAINER CHECK — captura, com foto ═════════════════════════
      // A tela de desktop é uma tabela de 1138px num shell com overflow:hidden e
      // sem media query: não cabe num telefone. O que é MESMO de telefone ali é
      // conferir um item e fotografar, então é isso que existe aqui; o resto
      // (Records, Need Review, histórico) continua na tela cheia, linkada.
      var cc = null;
      function ccNew() { return { code: '', dc5: '', qty: '', po: '', ocl: '', icl: '', bar: '', notes: '', photos: [], busy: 0 }; }
      function ccScreen(view) {
        if (!cc) cc = ccNew();
        var LAB = ['OK', 'Wrong', 'Missing', 'N/A'];
        function seg(id, cur) {
          var s = '<div class="cc-seg" id="' + id + '">';
          for (var i = 0; i < LAB.length; i++) {
            s += '<button data-v="' + LAB[i] + '"' + (cur === LAB[i] ? ' class="on"' : '') + '>' + LAB[i] + '</button>';
          }
          return s + '</div>';
        }
        view.innerHTML =
          '<p class="eyebrow">Container check</p>' +
          '<label class="lab-f"><span>Rapid code <i>(required)</i></span>' +
            '<input id="ccCode" value="' + esc(cc.code) + '" placeholder="Scan or type"></label>' +
          '<div class="lab-two">' +
            '<label class="lab-f"><span>5DC</span><input id="ccDc5" inputmode="numeric" value="' + esc(cc.dc5) + '"></label>' +
            '<label class="lab-f"><span>Qty</span><input id="ccQty" inputmode="numeric" value="' + esc(cc.qty) + '"></label>' +
          '</div>' +
          '<label class="lab-f"><span>PO</span><input id="ccPo" value="' + esc(cc.po) + '"></label>' +
          '<div class="cc-lab"><span>Outer carton label</span>' + seg('ccOcl', cc.ocl) + '</div>' +
          '<div class="cc-lab"><span>Inner carton label</span>' + seg('ccIcl', cc.icl) + '</div>' +
          '<div class="cc-lab"><span>Barcode</span>' + seg('ccBar', cc.bar) + '</div>' +
          '<label class="lab-f"><span>Notes</span><textarea id="ccNotes" rows="2">' + esc(cc.notes) + '</textarea></label>' +
          '<div class="cc-ph-h">Photos <i>' + cc.photos.length + ' of ' + MAX_PHOTOS + '</i></div>' +
          '<div class="cc-ph" id="ccPhotos"></div>' +
          // capture="environment" abre a câmera traseira direto; sem ele o
          // Android pergunta câmera-ou-galeria a cada foto.
          '<input type="file" id="ccFile" accept="image/*" capture="environment" multiple hidden>' +
          '<div class="meta" style="margin-top:14px"><a href="/features/container-check/container-check.html">Open the full Container Check</a> for records and review.</div>';
        bottom('<button class="btn" id="ccSave">Save check</button>');
        paintPhotos();

        function bindSeg(id, key) {
          var el = $(id); if (!el) return;
          var bs = el.querySelectorAll('button');
          for (var i = 0; i < bs.length; i++) {
            (function (b) {
              b.onclick = function () {
                cc[key] = (cc[key] === b.getAttribute('data-v')) ? '' : b.getAttribute('data-v');
                var all = el.querySelectorAll('button');
                for (var k = 0; k < all.length; k++) all[k].className = (all[k].getAttribute('data-v') === cc[key]) ? 'on' : '';
              };
            })(bs[i]);
          }
        }
        bindSeg('ccOcl', 'ocl'); bindSeg('ccIcl', 'icl'); bindSeg('ccBar', 'bar');

        ['ccCode:code', 'ccDc5:dc5', 'ccQty:qty', 'ccPo:po', 'ccNotes:notes'].forEach(function (pair) {
          var a = pair.split(':'), el = $(a[0]);
          if (el) el.oninput = function () { cc[a[1]] = el.value; };
        });

        // Preencher o 5DC sozinho quando o código bate — um campo a menos para
        // digitar de luva, e menos chance de casar errado depois.
        $('ccCode').addEventListener('blur', function () {
          var v = String(this.value || '').trim().toUpperCase();
          this.value = v; cc.code = v;
          if (!v || cc.dc5) return;
          searchProducts(v).then(function (items) {
            if (items.length && items[0].matchedBy !== 'partial' && items[0].dc5) {
              cc.dc5 = items[0].dc5;
              if ($('ccDc5')) $('ccDc5').value = cc.dc5;
            }
          }).catch(function () {});
        });

        function paintPhotos() {
          var el = $('ccPhotos'); if (!el) return;
          var s = '';
          for (var i = 0; i < cc.photos.length; i++) {
            s += '<div class="cc-ph-i"><img src="' + esc(cc.photos[i].url) + '" alt="Photo ' + (i + 1) + '">' +
                 '<button data-p="' + i + '" aria-label="Remove">&times;</button></div>';
          }
          for (var b = 0; b < cc.busy; b++) s += '<div class="cc-ph-i busy"><span class="spin"></span></div>';
          if (cc.photos.length + cc.busy < MAX_PHOTOS) s += '<button class="cc-ph-add" id="ccAdd">+<span>Photo</span></button>';
          el.innerHTML = s;
          var add = $('ccAdd'); if (add) add.onclick = function () { $('ccFile').click(); };
          var xs = el.querySelectorAll('[data-p]');
          for (var k = 0; k < xs.length; k++) {
            (function (btn) {
              btn.onclick = function () { cc.photos.splice(+btn.getAttribute('data-p'), 1); paintPhotos(); refreshCount(); };
            })(xs[k]);
          }
        }
        function refreshCount() {
          var h = view.querySelector('.cc-ph-h i');
          if (h) h.textContent = cc.photos.length + ' of ' + MAX_PHOTOS;
        }

        $('ccFile').onchange = function (ev) {
          var files = Array.prototype.slice.call(ev.target.files || []);
          ev.target.value = '';
          files.forEach(function (f) {
            if (cc.photos.length + cc.busy >= MAX_PHOTOS) { toast('Maximum ' + MAX_PHOTOS + ' photos', 'err'); return; }
            cc.busy++; paintPhotos();
            // Redimensiona NO TELEFONE. Uma foto de 12 MP em 4G é o caminho mais
            // curto para o operador achar que travou.
            shrink(f, 1280, 0.72).then(function (dataUrl) {
              return raw('POST', '/api/wms/cc-photo', { dataUrl: dataUrl, code: cc.code, date: today() });
            }).then(function (r) {
              cc.photos.push({ url: r.url, label: '' });
            }).catch(function (e) {
              toast('Photo failed: ' + e.message, 'err');
            }).then(function () {
              cc.busy--; paintPhotos(); refreshCount();
            });
          });
        };

        $('ccSave').onclick = function () {
          if (!cc.code.trim()) { toast('The Rapid code is required', 'err'); return; }
          if (cc.busy > 0) { toast('Wait for the photos to finish', 'err'); return; }
          var btn = this; btn.disabled = true; btn.textContent = 'Saving…';
          raw('POST', '/api/container-check/records', {
            check_date: today(), rapid_code: cc.code.trim(), five_dc: cc.dc5.trim(),
            qty: cc.qty === '' ? null : Number(cc.qty), po: cc.po.trim(),
            ocl: cc.ocl, icl: cc.icl, bar: cc.bar,
            photos: cc.photos, inventory_notes: cc.notes.trim()
          }, { 'x-cc-user': H.user() }).then(function () {
            toast('Saved — it goes to Need Review', 'ok');
            cc = ccNew();
            go('ccCheck', 'Container check');   // folha limpa para o próximo item
          }).catch(function (e) {
            btn.disabled = false; btn.textContent = 'Save check';
            toast(e.message, 'err');
          });
        };
      }

      // Redimensiona e devolve data URL. Canvas, igual ao desktop
      // (container-check.js:750) — mesma qualidade, mesmo tamanho.
      function shrink(file, maxDim, q) {
        return new Promise(function (resolve, reject) {
          var img = new Image();
          img.onload = function () {
            var w = img.naturalWidth, h = img.naturalHeight;
            var sc = Math.min(1, maxDim / Math.max(w, h));
            var c = document.createElement('canvas');
            c.width = Math.round(w * sc); c.height = Math.round(h * sc);
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            URL.revokeObjectURL(img.src);
            try { resolve(c.toDataURL('image/jpeg', q || 0.72)); }
            catch (e) { reject(new Error('could not read the photo')); }
          };
          img.onerror = function () { URL.revokeObjectURL(img.src); reject(new Error('invalid image')); };
          img.src = URL.createObjectURL(file);
        });
      }

      return {
        screens: {
          labels:    labelsScreen,
          labSearch: labSearchScreen,
          labMake:   labMakeScreen,
          labMulti:  labMultiScreen,
          ccCheck:   ccScreen
        },
        tiles: [
          { id: 'tLabels', title: 'Labels', sub: 'Search &amp; print, custom, multi', screen: 'labels' },
          { id: 'tCC', title: 'Container check', sub: 'Check an item and photograph it', screen: 'ccCheck' }
        ]
      };
    }
  };
})();
