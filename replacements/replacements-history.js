// =====================================================
// REPLACEMENTS HISTORY - JavaScript Logic
// =====================================================

let historyRequests = [];

// =====================================================
// INITIALIZATION
// =====================================================

document.addEventListener('DOMContentLoaded', async () => {
  await initHistory();
});

async function initHistory() {
  try {
    await window.supabaseReady;
    await loadHistory();
  } catch (e) {
    console.error('Init error:', e);
    toast('Failed to initialize', 'error');
  }
}

// =====================================================
// DATA LOADING
// =====================================================

async function loadHistory() {
  try {
    const { data, error } = await window.supabase
      .from('replacements_requests')
      .select(`
        *,
        replacements_items (*)
      `)
      .in('status', ['CONFIRMED', 'CANCELLED'])
      .order('created_at', { ascending: false });

    if (error) throw error;
    historyRequests = data || [];
    renderHistory();
  } catch (e) {
    console.error('Load history error:', e);
    document.getElementById('historyTbody').innerHTML = 
      '<tr><td colspan="14" style="text-align:center;color:#dc2626">Error loading data</td></tr>';
  }
}

// =====================================================
// RENDERING
// =====================================================

function renderHistory() {
  const tbody = document.getElementById('historyTbody');
  if (!tbody) return;

  const q = (document.getElementById('historySearch')?.value || '').toLowerCase();
  const filtered = historyRequests.filter(r => {
    if (!q) return true;
    return [
      formatReqNumber(r.request_number),
      r.customer,
      r.sales_order,
      r.sales_order_reference,
      r.confirmed_by,
      r.courier,
      r.consignment
    ].some(v => (v || '').toLowerCase().includes(q));
  });

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="14" style="text-align:center;opacity:.7">No history records</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(r => {
    const items = r.replacements_items || [];
    const productsSummary = items.length === 0 ? '—' :
      items.length === 1 ? `${items[0].code_5digit || items[0].product_sku} x${items[0].qty}` :
      `${items.length} items`;
    const productsTooltip = items.map(i => `${i.code_5digit || ''} ${i.product_sku || ''} x${i.qty}`).join(', ');
    const valueDisplay = r.value_aud ? `$${parseFloat(r.value_aud).toFixed(2)}` : '—';
    const statusClass = r.status === 'CONFIRMED' ? 'confirmed' : 'cancelled';
    const receivedDisplay = r.received ? '✅' : '—';
    
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
      <td style="text-align:center">${receivedDisplay}</td>
      <td>${escapeHtml(r.confirmed_by || r.cancelled_by || '—')}</td>
      <td>${escapeHtml(r.action_taken || '—')}</td>
      <td><span class="status-chip ${statusClass}">${r.status}</span></td>
      <td style="text-align:right">
        <button class="action-btn print" onclick="printRequest('${r.id}')">🖨️ Print</button>
      </td>
    </tr>`;
  }).join('');
}

function filterHistory() { renderHistory(); }

// =====================================================
// PRINT - PDF Generation
// =====================================================

function printRequest(id) {
  const req = historyRequests.find(r => r.id === id);
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
  const confirmedDate = req.confirmed_at ? formatDateFull(req.confirmed_at) : '—';
  const cancelledDate = req.cancelled_at ? formatDateFull(req.cancelled_at) : '—';
  const receivedDate = req.received_at ? formatDateShort(req.received_at) : '—';
  const isConfirmed = req.status === 'CONFIRMED';

  // Load JsBarcode if not loaded
  if (typeof JsBarcode === 'undefined') {
    await loadScript('https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js');
  }

  // Generate barcode as data URL
  const barcodeCanvas = document.createElement('canvas');
  JsBarcode(barcodeCanvas, reqNum, {
    format: 'CODE128',
    width: 2,
    height: 45,
    displayValue: false,
    margin: 0
  });
  const barcodeDataUrl = barcodeCanvas.toDataURL('image/png');

  const productRows = items.map(item => `
    <tr>
      <td>${escapeHtml(item.code_5digit || '—')}</td>
      <td>${escapeHtml(item.product_sku || '—')}</td>
      <td style="text-align: center; font-weight: 600;">${item.qty}</td>
    </tr>
  `).join('');

  // Create hidden container
  const container = document.createElement('div');
  container.id = 'pdf-container';
  container.style.cssText = 'position: fixed; left: -9999px; top: 0; width: 297mm; background: white;';

  container.innerHTML = `
    <style>
      #pdf-content {
        font-family: 'Segoe UI', Arial, sans-serif;
        font-size: 12px;
        color: #000;
        padding: 20px 30px;
        box-sizing: border-box;
      }
      .pdf-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        border-bottom: 3px solid #000;
        padding-bottom: 10px;
        margin-bottom: 12px;
      }
      .pdf-header h1 {
        font-size: 20px;
        color: #000;
        margin: 0 0 3px 0;
      }
      .pdf-header .subtitle {
        font-size: 11px;
        color: #333;
      }
      .pdf-header .req-num {
        font-size: 24px;
        font-weight: 700;
        font-family: 'Consolas', monospace;
        color: #000;
        text-align: right;
      }
      .pdf-header .status-badge {
        display: inline-block;
        padding: 5px 14px;
        border-radius: 15px;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        background: #fff;
        color: #000;
        border: 2px solid #000;
        margin-top: 5px;
      }
      .pdf-header .barcode img {
        height: 40px;
        margin-top: 5px;
      }
      .section-title {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        color: #000;
        margin: 12px 0 8px 0;
        padding-bottom: 4px;
        border-bottom: 2px solid #333;
      }
      .info-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 10px;
      }
      .info-item {
        flex: 1 1 calc(25% - 8px);
        min-width: 120px;
        background: #fff;
        border: 1px solid #333;
        border-radius: 5px;
        padding: 6px 10px;
      }
      .info-item.highlight {
        background: #fff;
        border: 2px solid #000;
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
        font-size: 12px;
        font-weight: 600;
        color: #000;
      }
      .info-item.highlight .val {
        color: #000;
        font-weight: 700;
      }
      .action-box {
        background: #fff;
        border: 2px solid #000;
        border-radius: 6px;
        padding: 10px 12px;
        margin: 10px 0;
      }
      .action-box h4 {
        font-size: 10px;
        text-transform: uppercase;
        color: #333;
        margin: 0 0 6px 0;
      }
      .action-box .content {
        font-size: 12px;
        color: #000;
        line-height: 1.4;
      }
      .comments-box {
        background: #fff;
        border: 1px solid #333;
        border-radius: 5px;
        padding: 8px 12px;
        margin-bottom: 10px;
      }
      .comments-box label {
        font-size: 9px;
        text-transform: uppercase;
        color: #333;
        font-weight: 600;
      }
      .comments-box .val {
        font-size: 11px;
        color: #000;
        margin-top: 3px;
      }
      .products-title {
        font-size: 11px;
        text-transform: uppercase;
        color: #000;
        border-bottom: 2px solid #333;
        padding-bottom: 4px;
        margin-bottom: 8px;
      }
      .products-tbl {
        width: 100%;
        border-collapse: collapse;
        margin-bottom: 10px;
      }
      .products-tbl th {
        background: #333;
        color: white;
        padding: 6px 10px;
        text-align: left;
        font-size: 9px;
        text-transform: uppercase;
      }
      .products-tbl td {
        padding: 6px 10px;
        border: 1px solid #333;
        font-size: 11px;
      }
      .products-tbl tr:nth-child(even) td {
        background: #f5f5f5;
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
          <h1>REPLACEMENT ${isConfirmed ? 'RESOLUTION' : 'CANCELLATION'} REPORT</h1>
          <div class="subtitle">Rapid LED — Warehouse Management</div>
        </div>
        <div>
          <div class="req-num">${reqNum}</div>
          <div class="status-badge">${req.status}</div>
          <div class="barcode">
            <img src="${barcodeDataUrl}" alt="Barcode">
          </div>
        </div>
      </div>

      <div class="section-title">REQUEST INFORMATION</div>
      <div class="info-row">
        <div class="info-item"><label>Created Date</label><div class="val">${createdDate}</div></div>
        <div class="info-item"><label>Customer</label><div class="val">${escapeHtml(req.customer)}</div></div>
        <div class="info-item"><label>Reason</label><div class="val">${escapeHtml(req.reason || '—')}</div></div>
        <div class="info-item"><label>Courier</label><div class="val">${escapeHtml(req.courier || '—')}</div></div>
        <div class="info-item"><label>Consignment</label><div class="val">${escapeHtml(req.consignment || '—')}</div></div>
        <div class="info-item"><label>Sales Order</label><div class="val">${escapeHtml(req.sales_order || '—')}</div></div>
        <div class="info-item"><label>SO Reference</label><div class="val">${escapeHtml(req.sales_order_reference || '—')}</div></div>
      </div>

      <div class="section-title">RESOLUTION DETAILS</div>
      <div class="info-row">
        <div class="info-item highlight"><label>Status</label><div class="val">${req.status}</div></div>
        <div class="info-item highlight"><label>${isConfirmed ? 'Confirmed' : 'Cancelled'} By</label><div class="val">${escapeHtml(isConfirmed ? req.confirmed_by : req.cancelled_by) || '—'}</div></div>
        <div class="info-item"><label>${isConfirmed ? 'Confirmed' : 'Cancelled'} Date</label><div class="val">${isConfirmed ? confirmedDate : cancelledDate}</div></div>
        <div class="info-item"><label>Resolution Type</label><div class="val">${escapeHtml(req.resolution_type || '—')}</div></div>
        <div class="info-item"><label>Received Date</label><div class="val">${receivedDate}</div></div>
      </div>

      ${req.action_taken ? `
      <div class="action-box">
        <h4>ACTION TAKEN / NOTES</h4>
        <div class="content">${escapeHtml(req.action_taken)}</div>
      </div>
      ` : ''}

      ${req.comments ? `
      <div class="comments-box">
        <label>Original Comments</label>
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

      <div class="pdf-footer">
        <strong>Resolution Report</strong> — Generated on ${new Date().toLocaleString()} — Rapid LED WMS
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
      filename: `Replacement_${reqNum}_${req.status}.pdf`,
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
// UTILITIES
// =====================================================

function formatReqNumber(num) {
  return 'REQ-' + String(num).padStart(6, '0');
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
window.filterHistory = filterHistory;
window.printRequest = printRequest;
