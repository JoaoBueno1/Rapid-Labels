// =====================================================
// REPLACEMENTS MODULE - JavaScript Logic
// =====================================================

// State
let activeRequests = [];
let draftProducts = [];
let operators = [];
let pendingConfirmId = null;
let pendingCancelId = null;

// =====================================================
// INITIALIZATION
// =====================================================

document.addEventListener('DOMContentLoaded', async () => {
  await initReplacements();
});

async function initReplacements() {
  try {
    await window.supabaseReady;
    await loadOperators();
    await loadActive();
    setupAutocomplete();
    setupCurrencyInput();
  } catch (e) {
    console.error('Init error:', e);
    toast('Failed to initialize', 'error');
  }
}

// =====================================================
// CURRENCY INPUT FORMATTING
// =====================================================

function setupCurrencyInput() {
  const input = document.getElementById('reqValue');
  if (!input) return;
  
  input.addEventListener('input', (e) => {
    // Remove all non-digits
    let digits = e.target.value.replace(/\D/g, '');
    
    // Remove leading zeros (but keep at least one)
    digits = digits.replace(/^0+/, '') || '0';
    
    // Pad with zeros if needed (minimum 3 digits for 0.0X)
    while (digits.length < 3) {
      digits = '0' + digits;
    }
    
    // Insert decimal point 2 places from end
    const intPart = digits.slice(0, -2);
    const decPart = digits.slice(-2);
    
    // Format with thousand separators
    const formattedInt = parseInt(intPart, 10).toLocaleString('en-AU');
    
    e.target.value = formattedInt + '.' + decPart;
  });
  
  // Prevent non-numeric input
  input.addEventListener('keydown', (e) => {
    // Allow: backspace, delete, tab, escape, enter, arrows
    if ([8, 9, 27, 13, 46, 37, 38, 39, 40].includes(e.keyCode)) return;
    // Allow: Ctrl/Cmd+A, Ctrl/Cmd+C, Ctrl/Cmd+V, Ctrl/Cmd+X
    if ((e.ctrlKey || e.metaKey) && [65, 67, 86, 88].includes(e.keyCode)) return;
    // Block non-numeric
    if ((e.keyCode < 48 || e.keyCode > 57) && (e.keyCode < 96 || e.keyCode > 105)) {
      e.preventDefault();
    }
  });
}

function parseCurrencyValue(value) {
  if (!value || value === '0.00') return null;
  // Remove thousand separators and parse
  const cleaned = value.replace(/,/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// =====================================================
// DATA LOADING
// =====================================================

async function loadActive() {
  try {
    const { data, error } = await window.supabase
      .from('replacements_requests')
      .select(`
        *,
        replacements_items (*)
      `)
      .eq('status', 'ACTIVE')
      .order('created_at', { ascending: false });

    if (error) throw error;
    activeRequests = data || [];
    renderActive();
  } catch (e) {
    console.error('Load active error:', e);
    document.getElementById('activeTbody').innerHTML = 
      '<tr><td colspan="9" style="text-align:center;color:#dc2626">Error loading data</td></tr>';
  }
}

async function loadOperators() {
  try {
    const { data, error } = await window.supabase
      .from('collection_operators')
      .select('name')
      .eq('active', true)
      .order('name');

    if (!error && data) {
      operators = data.map(o => o.name);
    }
  } catch (e) {
    console.warn('Could not load operators:', e);
    operators = ['Operator A', 'Operator B', 'Operator C'];
  }
  populateOperatorDropdown();
}

function populateOperatorDropdown() {
  const sel = document.getElementById('confirmBy');
  if (!sel) return;
  sel.innerHTML = '<option value="">Select operator...</option>';
  operators.forEach(op => {
    const opt = document.createElement('option');
    opt.value = op;
    opt.textContent = op;
    sel.appendChild(opt);
  });
}

// =====================================================
// RENDERING
// =====================================================

function renderActive() {
  const tbody = document.getElementById('activeTbody');
  if (!tbody) return;

  const q = (document.getElementById('activeSearch')?.value || '').toLowerCase();
  const filtered = activeRequests.filter(r => {
    if (!q) return true;
    return [
      formatReqNumber(r.request_number),
      r.customer,
      r.sales_order,
      r.sales_order_reference,
      r.courier,
      r.consignment
    ].some(v => (v || '').toLowerCase().includes(q));
  });

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;opacity:.7">No active replacements</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(r => {
    const items = r.replacements_items || [];
    const productsSummary = items.length === 0 ? '—' :
      items.length === 1 ? `${items[0].code_5digit || items[0].product_sku} x${items[0].qty}` :
      `${items.length} items`;
    const productsTooltip = items.map(i => `${i.code_5digit || ''} ${i.product_sku || ''} x${i.qty}`).join(', ');
    const valueDisplay = r.value_aud ? `$${parseFloat(r.value_aud).toFixed(2)}` : '—';

    return `<tr>
      <td><span class="req-number">${formatReqNumber(r.request_number)}</span></td>
      <td>${escapeHtml(r.customer)}</td>
      <td>${escapeHtml(r.reason || '—')}</td>
      <td>${escapeHtml(r.resolution_type || '—')}</td>
      <td>${escapeHtml(r.courier || '—')}</td>
      <td>${escapeHtml(r.consignment || '—')}</td>
      <td>${valueDisplay}</td>
      <td>${escapeHtml(r.sales_order || '—')}</td>
      <td><span class="products-summary" title="${escapeHtml(productsTooltip)}">${productsSummary}</span></td>
      <td>${formatDate(r.created_at)}</td>
      <td style="text-align:right">
        <button class="action-btn print" onclick="printRequest('${r.id}')">🖨️ Print</button>
        <button class="action-btn confirm" onclick="openConfirmModal('${r.id}')">✓ Confirm</button>
        <button class="action-btn cancel" onclick="openCancelModal('${r.id}')">✕ Cancel</button>
      </td>
    </tr>`;
  }).join('');
}

function filterActive() { renderActive(); }

// =====================================================
// ADD MODAL
// =====================================================

function openAddModal() {
  draftProducts = [];
  document.getElementById('addModalTitle').textContent = '➕ Add Replacement Request';
  // Set today's date as default
  document.getElementById('reqDate').value = new Date().toISOString().split('T')[0];
  document.getElementById('reqCustomer').value = '';
  document.getElementById('reqReason').value = '';
  document.getElementById('reqType').value = '';
  document.getElementById('reqCourier').value = '';
  document.getElementById('reqConsignment').value = '';
  document.getElementById('reqValue').value = '';
  document.getElementById('reqSalesOrder').value = '';
  document.getElementById('reqSalesOrderRef').value = '';
  document.getElementById('reqComments').value = '';
  clearProductInputs();
  renderProductLines();
  document.getElementById('addModal').classList.remove('hidden');
}

function closeAddModal() {
  document.getElementById('addModal').classList.add('hidden');
}

function clearProductInputs() {
  document.getElementById('prodCode').value = '';
  document.getElementById('prodSku').value = '';
  document.getElementById('prodQty').value = '1';
}

function addProductLine() {
  const code = document.getElementById('prodCode').value.trim();
  const sku = document.getElementById('prodSku').value.trim();
  const qty = parseInt(document.getElementById('prodQty').value) || 1;

  if (!code && !sku) {
    toast('Please enter a product code or SKU', 'warn');
    return;
  }
  if (qty < 1) {
    toast('Quantity must be at least 1', 'warn');
    return;
  }

  draftProducts.push({ code, sku, qty });
  clearProductInputs();
  renderProductLines();
  document.getElementById('prodCode').focus();
  toast('Product added', 'success');
}

function removeProductLine(index) {
  draftProducts.splice(index, 1);
  renderProductLines();
}

function renderProductLines() {
  const container = document.getElementById('productLines');
  if (!container) return;

  if (draftProducts.length === 0) {
    container.innerHTML = '<div class="empty-products">No products added yet</div>';
    return;
  }

  container.innerHTML = draftProducts.map((p, i) => `
    <div class="product-line">
      <span class="code">${escapeHtml(p.code) || '—'}</span>
      <span class="sku">${escapeHtml(p.sku) || '—'}</span>
      <span class="qty">x${p.qty}</span>
      <button class="remove-btn" onclick="removeProductLine(${i})" title="Remove">✕</button>
    </div>
  `).join('');
}

async function saveReplacement(shouldPrint) {
  const reqDate = document.getElementById('reqDate').value;
  const customer = document.getElementById('reqCustomer').value.trim();
  const reason = document.getElementById('reqReason').value;
  const resolutionType = document.getElementById('reqType').value || null;
  const courier = document.getElementById('reqCourier').value.trim();
  const consignment = document.getElementById('reqConsignment').value.trim();
  const valueAud = parseCurrencyValue(document.getElementById('reqValue').value);
  const salesOrder = document.getElementById('reqSalesOrder').value.trim();
  const salesOrderRef = document.getElementById('reqSalesOrderRef').value.trim();
  const comments = document.getElementById('reqComments').value.trim();

  // Validation
  if (!reqDate) {
    toast('Date is required', 'error');
    return;
  }
  if (!customer) {
    toast('Customer is required', 'error');
    return;
  }
  if (draftProducts.length === 0) {
    toast('Please add at least one product', 'error');
    return;
  }

  try {
    // Insert main request
    const { data: reqData, error: reqError } = await window.supabase
      .from('replacements_requests')
      .insert({
        created_at: new Date(reqDate + 'T12:00:00').toISOString(),
        customer,
        reason,
        resolution_type: resolutionType,
        courier,
        consignment,
        value_aud: valueAud,
        sales_order: salesOrder,
        sales_order_reference: salesOrderRef,
        comments,
        status: 'ACTIVE'
      })
      .select()
      .single();

    if (reqError) throw reqError;

    // Insert items
    const items = draftProducts.map(p => ({
      request_id: reqData.id,
      code_5digit: p.code,
      product_sku: p.sku,
      qty: p.qty
    }));

    const { error: itemsError } = await window.supabase
      .from('replacements_items')
      .insert(items);

    if (itemsError) throw itemsError;

    toast('Replacement request created!', 'success');
    closeAddModal();
    await loadActive();

    if (shouldPrint) {
      printRequest(reqData.id);
    }
  } catch (e) {
    console.error('Save error:', e);
    toast('Failed to save: ' + e.message, 'error');
  }
}

// =====================================================
// CONFIRM MODAL
// =====================================================

function openConfirmModal(id) {
  pendingConfirmId = id;
  const req = activeRequests.find(r => r.id === id);
  if (!req) return;

  document.getElementById('confirmReqNumber').textContent = formatReqNumber(req.request_number);
  document.getElementById('confirmReceivedDate').value = new Date().toISOString().split('T')[0];
  document.getElementById('confirmBy').value = '';
  document.getElementById('confirmAction').value = '';
  document.getElementById('confirmModal').classList.remove('hidden');
}

function closeConfirmModal() {
  document.getElementById('confirmModal').classList.add('hidden');
  pendingConfirmId = null;
}

async function submitConfirm() {
  if (!pendingConfirmId) return;

  const receivedDate = document.getElementById('confirmReceivedDate').value;
  const confirmedBy = document.getElementById('confirmBy').value;
  const actionTaken = document.getElementById('confirmAction').value.trim();

  if (!receivedDate) {
    toast('Received date is required', 'error');
    return;
  }
  if (!confirmedBy) {
    toast('Please select who confirmed', 'error');
    return;
  }

  try {
    const { error } = await window.supabase
      .from('replacements_requests')
      .update({
        status: 'CONFIRMED',
        received_at: receivedDate,
        confirmed_by: confirmedBy,
        confirmed_at: new Date().toISOString(),
        action_taken: actionTaken
      })
      .eq('id', pendingConfirmId);

    if (error) throw error;

    toast('Replacement confirmed!', 'success');
    closeConfirmModal();
    await loadActive();
  } catch (e) {
    console.error('Confirm error:', e);
    toast('Failed to confirm: ' + e.message, 'error');
  }
}

// =====================================================
// CANCEL MODAL
// =====================================================

function openCancelModal(id) {
  pendingCancelId = id;
  const req = activeRequests.find(r => r.id === id);
  if (!req) return;

  document.getElementById('cancelMessage').textContent = 
    `Are you sure you want to cancel request ${formatReqNumber(req.request_number)} for ${req.customer}?`;
  document.getElementById('cancelModal').classList.remove('hidden');
}

function closeCancelModal() {
  document.getElementById('cancelModal').classList.add('hidden');
  pendingCancelId = null;
}

async function submitCancel() {
  if (!pendingCancelId) return;

  try {
    const { error } = await window.supabase
      .from('replacements_requests')
      .update({
        status: 'CANCELLED',
        cancelled_at: new Date().toISOString(),
        cancelled_by: 'User' // Could add user selection here
      })
      .eq('id', pendingCancelId);

    if (error) throw error;

    toast('Replacement cancelled', 'success');
    closeCancelModal();
    await loadActive();
  } catch (e) {
    console.error('Cancel error:', e);
    toast('Failed to cancel: ' + e.message, 'error');
  }
}

// =====================================================
// PRINT
// =====================================================

function printRequest(id) {
  // Find in active requests
  const req = activeRequests.find(r => r.id === id);
  if (!req) {
    toast('Request not found', 'error');
    return;
  }

  generatePDF(req);
}

async function generatePDF(req) {
  const items = req.replacements_items || [];
  const reqNum = formatReqNumber(req.request_number);
  const createdDate = formatDateFull(req.created_at);

  // Load JsBarcode if not loaded
  if (typeof JsBarcode === 'undefined') {
    await loadScript('https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js');
  }

  // Generate barcode as SVG string
  const barcodeCanvas = document.createElement('canvas');
  JsBarcode(barcodeCanvas, reqNum, {
    format: 'CODE128',
    width: 2,
    height: 50,
    displayValue: false,
    margin: 0
  });
  const barcodeDataUrl = barcodeCanvas.toDataURL('image/png');

  // Create hidden container
  const container = document.createElement('div');
  container.id = 'pdf-container';
  container.style.cssText = 'position: fixed; left: -9999px; top: 0; width: 297mm; background: white';
  
  const productRows = items.map(item => `
    <tr>
      <td>${escapeHtml(item.code_5digit || '—')}</td>
      <td>${escapeHtml(item.product_sku || '—')}</td>
      <td style="text-align: center; font-weight: 600;">${item.qty}</td>
    </tr>
  `).join('');

  container.innerHTML = `
    <style>
      #pdf-content {
        font-family: 'Segoe UI', Arial, sans-serif;
        font-size: 13px;
        color: #000;
        padding: 25px 35px;
        box-sizing: border-box;
      }
      .pdf-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        border-bottom: 3px solid #000;
        padding-bottom: 12px;
        margin-bottom: 15px;
      }
      .pdf-header h1 {
        font-size: 22px;
        color: #000;
        margin: 0 0 3px 0;
      }
      .pdf-header .subtitle {
        font-size: 12px;
        color: #333;
      }
      .pdf-header .req-num {
        font-size: 26px;
        font-weight: 700;
        font-family: 'Consolas', monospace;
        color: #000;
        text-align: right;
      }
      .pdf-header .barcode img {
        height: 45px;
        margin-top: 5px;
      }
      .info-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-bottom: 12px;
      }
      .info-item {
        flex: 1 1 calc(25% - 10px);
        min-width: 140px;
        background: #fff;
        border: 1px solid #333;
        border-radius: 5px;
        padding: 8px 12px;
      }
      .info-item label {
        display: block;
        font-size: 9px;
        text-transform: uppercase;
        color: #333;
        font-weight: 600;
        margin-bottom: 2px;
      }
      .info-item .val {
        font-size: 13px;
        font-weight: 600;
        color: #000;
      }
      .comments-section {
        background: #fff;
        border: 2px solid #333;
        border-radius: 5px;
        padding: 10px 14px;
        margin-bottom: 12px;
      }
      .comments-section label {
        font-size: 9px;
        text-transform: uppercase;
        color: #333;
        font-weight: 600;
      }
      .comments-section .val {
        font-size: 12px;
        color: #000;
        margin-top: 3px;
      }
      .products-title {
        font-size: 13px;
        text-transform: uppercase;
        color: #000;
        border-bottom: 2px solid #333;
        padding-bottom: 5px;
        margin-bottom: 8px;
      }
      .products-tbl {
        width: 100%;
        border-collapse: collapse;
        margin-bottom: 12px;
      }
      .products-tbl th {
        background: #333;
        color: white;
        padding: 8px 12px;
        text-align: left;
        font-size: 10px;
        text-transform: uppercase;
      }
      .products-tbl td {
        padding: 8px 12px;
        border: 1px solid #333;
        font-size: 12px;
      }
      .products-tbl tr:nth-child(even) td {
        background: #f5f5f5;
      }
      .bottom-section {
        display: flex;
        gap: 20px;
        margin-top: 10px;
      }
      .notes-box {
        flex: 1;
        border: 2px dashed #333;
        border-radius: 6px;
        padding: 12px;
        background: #fff;
      }
      .notes-box h4 {
        font-size: 10px;
        text-transform: uppercase;
        color: #333;
        margin: 0 0 8px 0;
      }
      .notes-box .line {
        border-bottom: 1px solid #333;
        height: 22px;
      }
      .sig-section {
        display: flex;
        gap: 30px;
        flex: 1;
      }
      .sig-item {
        flex: 1;
      }
      .sig-item .line {
        border-bottom: 2px solid #000;
        height: 30px;
        margin-bottom: 4px;
      }
      .sig-item label {
        font-size: 10px;
        color: #333;
      }
      .pdf-footer {
        text-align: center;
        font-size: 9px;
        color: #666;
        margin-top: 12px;
        padding-top: 8px;
        border-top: 1px solid #333;
      }
    </style>
    <div id="pdf-content">
      <div class="pdf-header">
        <div>
          <h1>REPLACEMENT RETURN REQUEST</h1>
          <div class="subtitle">Rapid LED Australia</div>
        </div>
        <div>
          <div class="req-num">${reqNum}</div>
          <div class="barcode">
            <img src="${barcodeDataUrl}" alt="Barcode">
          </div>
        </div>
      </div>

      <div class="info-row">
        <div class="info-item"><label>Date</label><div class="val">${createdDate}</div></div>
        <div class="info-item"><label>Customer</label><div class="val">${escapeHtml(req.customer)}</div></div>
        <div class="info-item"><label>Reason</label><div class="val">${escapeHtml(req.reason || '—')}</div></div>
        <div class="info-item"><label>Resolution</label><div class="val">${escapeHtml(req.resolution_type || '—')}</div></div>
        <div class="info-item"><label>Courier</label><div class="val">${escapeHtml(req.courier || '—')}</div></div>
        <div class="info-item"><label>Consignment</label><div class="val">${escapeHtml(req.consignment || '—')}</div></div>
        <div class="info-item"><label>Sales Order</label><div class="val">${escapeHtml(req.sales_order || '—')}</div></div>
        <div class="info-item"><label>SO Reference</label><div class="val">${escapeHtml(req.sales_order_reference || '—')}</div></div>
      </div>

      ${req.comments ? `
      <div class="comments-section">
        <label>COMMENTS</label>
        <div class="val">${escapeHtml(req.comments)}</div>
      </div>
      ` : ''}

      <div class="products-title">PRODUCTS</div>
      <table class="products-tbl">
        <thead>
          <tr>
            <th style="width: 100px;">Code</th>
            <th>Product / SKU</th>
            <th style="width: 80px; text-align: center;">Qty</th>
          </tr>
        </thead>
        <tbody>
          ${productRows || '<tr><td colspan="3" style="text-align:center;padding:15px;color:#94a3b8">No products</td></tr>'}
        </tbody>
      </table>

      <div class="bottom-section">
        <div class="notes-box">
          <h4>WAREHOUSE NOTES</h4>
          <div class="line"></div>
          <div class="line"></div>
        </div>
        <div class="sig-section">
          <div class="sig-item">
            <div class="line"></div>
            <label>Received By</label>
          </div>
          <div class="sig-item">
            <div class="line"></div>
            <label>Date</label>
          </div>
        </div>
      </div>

      <div class="pdf-footer">
        Generated on ${new Date().toLocaleString()} — Rapid Express WMS
      </div>
    </div>
  `;

  document.body.appendChild(container);

  // Load html2pdf dynamically if not loaded
  if (typeof html2pdf === 'undefined') {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js');
  }

  try {
    const element = container.querySelector('#pdf-content');
    const opt = {
      margin: [8, 8, 8, 8],
      filename: `Replacement_${reqNum}.pdf`,
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true, allowTaint: true },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' }
    };

    // Generate and open PDF
    const pdfBlob = await html2pdf().set(opt).from(element).outputPdf('blob');
    const pdfUrl = URL.createObjectURL(pdfBlob);
    window.open(pdfUrl, '_blank');
    
    toast('PDF generated successfully', 'success');
  } catch (err) {
    console.error('PDF generation error:', err);
    toast('Failed to generate PDF', 'error');
  } finally {
    document.body.removeChild(container);
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

// =====================================================
// AUTOCOMPLETE FOR PRODUCTS
// =====================================================

let acTimer = null;

function setupAutocomplete() {
  const codeInput = document.getElementById('prodCode');
  const skuInput = document.getElementById('prodSku');
  const codePanel = document.getElementById('prodCodeAC');
  const skuPanel = document.getElementById('prodSkuAC');

  if (codeInput && codePanel) {
    codeInput.addEventListener('input', () => {
      clearTimeout(acTimer);
      acTimer = setTimeout(() => searchProducts(codeInput.value, codePanel, 'code'), 200);
    });
    codeInput.addEventListener('blur', () => setTimeout(() => codePanel.style.display = 'none', 150));
  }

  if (skuInput && skuPanel) {
    skuInput.addEventListener('input', () => {
      clearTimeout(acTimer);
      acTimer = setTimeout(() => searchProducts(skuInput.value, skuPanel, 'sku'), 200);
    });
    skuInput.addEventListener('blur', () => setTimeout(() => skuPanel.style.display = 'none', 150));
  }
}

async function searchProducts(term, panel, type) {
  if (!term || term.length < 2) {
    panel.style.display = 'none';
    return;
  }

  try {
    if (window.supabaseSearch && window.supabaseSearch.searchBarcodes) {
      const res = await window.supabaseSearch.searchBarcodes(term);
      if (res.success && res.items && res.items.length > 0) {
        showAutocomplete(res.items, panel, type);
        return;
      }
    }
    panel.style.display = 'none';
  } catch (e) {
    console.warn('Autocomplete error:', e);
    panel.style.display = 'none';
  }
}

function showAutocomplete(items, panel, type) {
  panel.innerHTML = items.slice(0, 10).map(item => `
    <div class="ac-item" onclick="selectProduct('${escapeHtml(item.sku || '')}', '${escapeHtml(item.product || '')}')">
      <span class="ac-left">${escapeHtml(item.sku || '—')}</span>
      <span class="ac-right">${escapeHtml(item.product || '—')}</span>
    </div>
  `).join('');
  panel.style.display = 'block';
}

function selectProduct(code, product) {
  document.getElementById('prodCode').value = code;
  document.getElementById('prodSku').value = product;
  document.getElementById('prodCodeAC').style.display = 'none';
  document.getElementById('prodSkuAC').style.display = 'none';
  document.getElementById('prodQty').value = '';
  document.getElementById('prodQty').focus();
}

// =====================================================
// UTILITIES
// =====================================================

function formatReqNumber(num) {
  return 'REQ-' + String(num).padStart(6, '0');
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

function formatDateShort(dateStr) {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    return `${dd}/${mm}/${yy}`;
  } catch {
    return dateStr;
  }
}

function formatDateFull(dateStr) {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-GB', { 
      day: '2-digit', 
      month: 'long', 
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return dateStr;
  }
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) {
    console.log(`[${type}] ${message}`);
    return;
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Expose functions globally
window.filterActive = filterActive;
window.openAddModal = openAddModal;
window.closeAddModal = closeAddModal;
window.addProductLine = addProductLine;
window.removeProductLine = removeProductLine;
window.saveReplacement = saveReplacement;
window.openConfirmModal = openConfirmModal;
window.closeConfirmModal = closeConfirmModal;
window.submitConfirm = submitConfirm;
window.openCancelModal = openCancelModal;
window.closeCancelModal = closeCancelModal;
window.submitCancel = submitCancel;
window.printRequest = printRequest;
window.selectProduct = selectProduct;
