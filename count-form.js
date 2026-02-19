// Count Form Logic
const state = {
  token: null,
  session: null,
  items: [],
  warehouse: null
};

const STORAGE_KEY_PREFIX = 'count_form_';

// Initialize
document.addEventListener('DOMContentLoaded', async function() {
  console.log('📦 Count Form loading...');
  
  // Get token from URL
  const params = new URLSearchParams(window.location.search);
  state.token = params.get('token');
  
  if (!state.token) {
    showError('Invalid link: No session token provided');
    return;
  }
  
  await loadSession();
});

// Load session data
async function loadSession() {
  try {
    await window.supabaseReady;
    
    // Get session
    const { data: session, error: sessionError } = await window.supabase
      .from('count_sessions')
      .select(`
        *,
        audit_warehouses:warehouse_id (code, name)
      `)
      .eq('session_token', state.token)
      .single();
    
    if (sessionError) {
      console.error('Session error:', sessionError);
      showError('Session not found or invalid');
      return;
    }
    
    // Check expiration
    if (new Date(session.expires_at) < new Date()) {
      showError('This count session has expired');
      return;
    }
    
    // Check if already submitted
    if (session.status === 'submitted') {
      showReadOnly(session);
      return;
    }
    
    state.session = session;
    state.warehouse = session.audit_warehouses;
    
    // Load items
    const { data: items, error: itemsError } = await window.supabase
      .from('count_session_items')
      .select(`
        *,
        audit_products:product_id (sku_code, display_code, product_name)
      `)
      .eq('session_id', session.id);
    
    if (itemsError) throw itemsError;
    
    // FIXED PRODUCT ORDER - Same as cyclic-count.js (position 47 = DEK-RUSSELL-L-BK-DC)
    const CUSTOM_PRODUCT_ORDER = [
      'DEK-ALBANY48-WH', 'DEK-ALBANY48-BK', 'DEK-ALBANY48-L-BK', 'DEK-ALBANY48-L-WH',
      'DEK-ALBANY52-BK', 'DEK-ALBANY52-L-BK', 'DEK-ALBANY52-L-WH', 'DEK-ALBANY52-WH',
      'DEK-EVOII50-BK', 'DEK-EVOII50-BK-DC', 'DEK-EVOII50-L-WH', 'DEK-EVOII50-L-WH-DC',
      'DEK-EVOII50-L-BK-DC', 'DEK-EVOII50-WH', 'DEK-EVOII50-WH-DC', 'DEK-EVOII58-BK',
      'DEK-EVOII58-BK-DC', 'DEK-EVOII58-L-BK', 'DEK-EVOII58-WH', 'DEK-EVOII58-WH-DC',
      'EP-HYB-240-RF-10', 'EP-HYB-RF-MOD', 'EP-RANG-RF-10', 'EP-SA-CONT-RF',
      'EP-VC-240-1', 'EP-VC-240-10', 'EP-VC-RF-MOD', 'DEK-HAWK48-L-WH',
      'DEK-HAWK48-L-WH-DC', 'DEK-HAWK48-WH', 'DEK-HAWK48-WH-DC', 'DEK-INGRAM-BK-DC',
      'DEK-INGRAM-L-BK', 'DEK-INGRAM-L-BK-DC', 'DEK-INGRAM-L-WH', 'DEK-INGRAM-L-WH-DC',
      'DEK-INGRAM-WH', 'DEK-INGRAM-WH-DC', 'DEK-RONDO52-L-BK', 'DEK-RONDO58-L-BK',
      'DEK-RONDOII52-L-WH', 'DEK-RONDOII52-L-BK', 'DEK-RONDOII52-WH', 'DEK-RONDOII58-BK',
      'DEK-RONDOII58-L-WH', 'DEK-RUSSELL-BK-DC', 'DEK-RUSSELL-L-BK-DC', 'DEK-RUSSELL-L-BK',
      'DEK-RUSSELL-L-WH', 'DEK-RUSSELL-L-WH-DC', 'DEK-RUSSELL-WH', 'DEK-RUSSELL-WH-DC',
      'R10', 'R10RF', 'R10RFB', 'R10RFP', 'R240', 'R240ACB', 'R240B', 'R240RC', 'R240RCB',
      'RAC', 'RAC240', 'RFMDUAL', 'RFMOD', 'RHA10RF', 'RHA240SL', 'RSDUALP', 'RSG4',
      'RWB', 'RWB2', 'RWBB', 'R360-SIMPLICITY-WH', 'VEN-DC31203-L-WH', 'VEN-DC31203-WH',
      'VEN-GLA1203-L-BK', 'VEN-GLA1203-L-WH', 'VEN-GLA1203-WH', 'VEN-GLA1303-BK',
      'VEN-GLA1303-L-WH', 'VEN-GLA1303-WH', 'VEN-SKY1203WH', 'VEN-SKY1203WH-L',
      'VEN-SKY1303BL', 'VEN-SKY1303-WH', 'VEN-SKY1303-WH-L', 'VEN-SKY1503-BL',
      'VEN-SKY1503-WH', 'VEN-SKY1503-WH-L', 'VEN-SPY0903-WH', 'VEN-SPY1253-L-WH',
      'VEN-SPY1253-WH', 'VEN-SPY1573-BK'
    ];
    
    if (items) {
      items.sort((a, b) => {
        const nameA = a.audit_products?.product_name || '';
        const nameB = b.audit_products?.product_name || '';
        const indexA = CUSTOM_PRODUCT_ORDER.indexOf(nameA);
        const indexB = CUSTOM_PRODUCT_ORDER.indexOf(nameB);
        const orderA = indexA >= 0 ? indexA : 9999;
        const orderB = indexB >= 0 ? indexB : 9999;
        return orderA - orderB;
      });
    }
    
    state.items = items || [];
    
    // Load saved progress from localStorage
    loadProgress();
    
    // Render form
    renderForm();
    
  } catch (error) {
    console.error('Error loading session:', error);
    showError('Error loading session: ' + error.message);
  }
}

// Render form
function renderForm() {
  document.getElementById('loadingState').style.display = 'none';
  document.getElementById('mainForm').style.display = 'block';
  
  // Set header info
  document.getElementById('warehouseName').textContent = state.warehouse.name;
  document.getElementById('sessionToken').textContent = state.token;
  document.getElementById('sessionExpires').textContent = new Date(state.session.expires_at).toLocaleString('en-AU');
  
  // Render table
  const tbody = document.getElementById('countTableBody');
  tbody.innerHTML = state.items.map((item, index) => {
    const product = item.audit_products;
    const sku = product.display_code || product.sku_code;
    
    return `
      <tr>
        <td><strong>${sku}</strong></td>
        <td>${product.product_name || 'Unknown Product'}</td>
        <td style="text-align:center;font-weight:500">${item.system_count}</td>
        <td style="text-align:center">
          <input type="number" 
                 class="count-input" 
                 id="physical_${index}"
                 placeholder="0"
                 min="0"
                 value="${item.physical_count !== null ? item.physical_count : ''}"
                 onchange="updateCount(${index}, this.value)"
                 onkeypress="if(event.key==='Enter') focusNext(${index})" />
        </td>
        <td>
          <input type="text" 
                 class="notes-input" 
                 id="notes_${index}"
                 placeholder="Optional notes..."
                 value="${item.notes || ''}"
                 onchange="updateNotes(${index}, this.value)" />
        </td>
      </tr>
    `;
  }).join('');
  
  updateProgress();
  
  // Focus first input
  setTimeout(() => {
    document.getElementById('physical_0')?.focus();
  }, 100);
}

// Update count
window.updateCount = function(index, value) {
  const numValue = value ? parseInt(value) : null;
  state.items[index].physical_count = numValue;
  updateProgress();
  saveProgress();
};

// Update notes
window.updateNotes = function(index, value) {
  state.items[index].notes = value || null;
  saveProgress();
};

// Focus next input
window.focusNext = function(index) {
  const nextInput = document.getElementById(`physical_${index + 1}`);
  if (nextInput) {
    nextInput.focus();
    nextInput.select();
  }
};

// Update progress
function updateProgress() {
  const counted = state.items.filter(item => item.physical_count !== null).length;
  const total = state.items.length;
  const percentage = total > 0 ? (counted / total) * 100 : 0;
  
  document.getElementById('progressBar').style.width = percentage + '%';
  document.getElementById('progressText').textContent = `${counted}/${total}`;
}

// Save progress to localStorage
function saveProgress() {
  const storageKey = STORAGE_KEY_PREFIX + state.token;
  const progress = {
    counterName: document.getElementById('counterName').value,
    items: state.items.map(item => ({
      id: item.id,
      physical_count: item.physical_count,
      notes: item.notes
    })),
    timestamp: new Date().toISOString()
  };
  localStorage.setItem(storageKey, JSON.stringify(progress));
}

// Load progress from localStorage
function loadProgress() {
  const storageKey = STORAGE_KEY_PREFIX + state.token;
  const stored = localStorage.getItem(storageKey);
  
  if (stored) {
    try {
      const progress = JSON.parse(stored);
      
      // Restore counter name
      if (progress.counterName) {
        document.getElementById('counterName').value = progress.counterName;
      }
      
      // Restore counts and notes
      progress.items.forEach(saved => {
        const item = state.items.find(i => i.id === saved.id);
        if (item) {
          item.physical_count = saved.physical_count;
          item.notes = saved.notes;
        }
      });
      
      console.log('✅ Restored progress from', new Date(progress.timestamp).toLocaleString());
    } catch (e) {
      console.error('Error loading progress:', e);
    }
  }
}

// Confirm submit
window.confirmSubmit = function() {
  const counted = state.items.filter(item => item.physical_count !== null).length;
  const total = state.items.length;
  
  document.getElementById('confirmCounted').textContent = counted;
  document.getElementById('confirmTotal').textContent = total;
  document.getElementById('confirmModal').style.display = 'flex';
};

window.closeConfirmModal = function() {
  document.getElementById('confirmModal').style.display = 'none';
};

// Submit count
window.submitCount = async function() {
  const submitBtn = document.getElementById('submitBtn');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting...';
  
  try {
    await window.supabaseReady;
    
    const counterName = document.getElementById('counterName').value || 'Anonymous';
    
    // Update all items
    const updates = state.items.map(item => ({
      id: item.id,
      physical_count: item.physical_count,
      notes: item.notes,
      updated_at: new Date().toISOString()
    }));
    
    for (const update of updates) {
      await window.supabase
        .from('count_session_items')
        .update(update)
        .eq('id', update.id);
    }
    
    // Update session status
    await window.supabase
      .from('count_sessions')
      .update({
        status: 'submitted',
        submitted_at: new Date().toISOString(),
        submitted_by: counterName
      })
      .eq('id', state.session.id);
    
    // Update audit_stock_analysis with physical counts
    for (const item of state.items) {
      if (item.physical_count !== null) {
        // Find the analysis record for this product/warehouse
        const { data: analysis } = await window.supabase
          .from('audit_stock_analysis')
          .select('id')
          .eq('run_id', state.session.run_id)
          .eq('product_id', item.product_id)
          .limit(1)
          .single();
        
        if (analysis) {
          await window.supabase
            .from('audit_stock_analysis')
            .update({ physical_count: item.physical_count })
            .eq('id', analysis.id);
        }
      }
    }
    
    // Clear localStorage
    const storageKey = STORAGE_KEY_PREFIX + state.token;
    localStorage.removeItem(storageKey);
    
    // Show success
    closeConfirmModal();
    showSuccess(counterName);
    
  } catch (error) {
    console.error('Error submitting count:', error);
    alert('Error submitting count: ' + error.message);
    submitBtn.disabled = false;
    submitBtn.textContent = '✅ Confirm & Submit Count';
  }
};

// Show error state
function showError(message) {
  document.getElementById('loadingState').style.display = 'none';
  document.getElementById('mainForm').style.display = 'none';
  document.getElementById('errorState').style.display = 'block';
  document.getElementById('errorMessage').textContent = message;
}

// Show read-only state
function showReadOnly(session) {
  document.getElementById('loadingState').style.display = 'none';
  document.getElementById('mainForm').style.display = 'none';
  document.getElementById('readonlyState').style.display = 'block';
  document.getElementById('submittedBy').textContent = session.submitted_by || 'Unknown';
  document.getElementById('submittedAt').textContent = new Date(session.submitted_at).toLocaleString('en-AU');
}

// Show success message
function showSuccess(counterName) {
  document.getElementById('mainForm').style.display = 'none';
  document.getElementById('readonlyState').style.display = 'block';
  document.getElementById('submittedBy').textContent = counterName;
  document.getElementById('submittedAt').textContent = new Date().toLocaleString('en-AU');
}

console.log('✅ Count Form loaded');
