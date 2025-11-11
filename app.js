// Global variables
let selectedSearchSize = null;
let selectedManualSize = null;
let searchPages = 1;
let manualPages = 1;
let selectedProduct = null;

// Helper function: Get today's date in local timezone (YYYY-MM-DD)
// Avoids UTC timezone issues that cause wrong date display
function getTodayLocalYMD() {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Page load initialization
document.addEventListener('DOMContentLoaded', function() {
    console.log('🚀 Page loading...');
    
    // Debug: Check if manual modal elements exist
    const manualModal = document.getElementById('manualModal');
    const manualSku = document.getElementById('manualSku');
    const manualCode = document.getElementById('manualCode');
    const manualQty = document.getElementById('manualQty');
    
    console.log('🔧 Manual modal elements check:');
    console.log('Modal:', manualModal ? '✅ Found' : '❌ Not found');
    console.log('SKU field:', manualSku ? '✅ Found' : '❌ Not found');
    console.log('Code field:', manualCode ? '✅ Found' : '❌ Not found');
    console.log('Qty field:', manualQty ? '✅ Found' : '❌ Not found');
    
    // Set current date as default (using local timezone)
    const today = getTodayLocalYMD();
    const editDateInput = document.getElementById('editDate');
    const manualDateInput = document.getElementById('manualDate');
    
    if (editDateInput) editDateInput.value = today;
    if (manualDateInput) manualDateInput.value = today;
    
    // Event listeners for manual form
    const manualForm = document.getElementById('manualForm');
    if (manualForm) {
        manualForm.addEventListener('submit', handleManualSubmit);
    }

    // Work around CSP: attach Barcodes modal open handlers without inline attributes
    try {
        const triggers = Array.from(document.querySelectorAll('[onclick*="openBarcodesModal"]'));
        triggers.forEach(el => {
            // Remove inline handler blocked by CSP
            try { el.removeAttribute('onclick'); } catch(_){ }
            // For anchors, make hash navigation open via existing hash watcher too
            if (el.tagName === 'A') {
                el.setAttribute('href', '#barcodes');
            }
            el.addEventListener('click', (e)=>{
                e.preventDefault();
                try { openBarcodesModal(); } catch(_){ }
            });
        });
    } catch (_) { }

    // Global hash routing for modals across all pages
    function handleHashRouting(){
        const h = (location.hash || '').toLowerCase();
        if (h === '#search') { try { openSearchModal(); } catch(_){} }
        else if (h === '#manual') { try { openManualModal(); } catch(_){} }
        else if (h === '#barcodes') { try { openBarcodesModal(); } catch(_){} }
    }
    try {
        // Open on initial load if hash is present
        handleHashRouting();
        // React to hash changes
        window.addEventListener('hashchange', handleHashRouting);
        // Also bind clicks to ensure opening even if hash doesn't change
        document.querySelectorAll('a[href="#search"], a[href="#manual"], a[href="#barcodes"]').forEach(a => {
            a.addEventListener('click', (e)=>{
                e.preventDefault();
                const href = a.getAttribute('href') || '';
                if (location.hash !== href) {
                    location.hash = href;
                } else {
                    // If hash is already the same, still trigger routing
                    handleHashRouting();
                }
            });
        });
    } catch(_){}
    
    // Event listener for real-time search (guard missing performSearch to avoid breaking other inits)
    const searchInput = document.getElementById('productSearch');
    if (searchInput) {
        if (typeof performSearch === 'function') {
            searchInput.addEventListener('input', debounce(performSearch, 300));
        } else {
            // no-op to keep DOMContentLoaded running and not block Barcodes modal init
            searchInput.addEventListener('input', debounce(() => {}, 300));
        }
        searchInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                if (typeof searchProduct === 'function') {
                    searchProduct();
                }
            }
        });
    }
    
    // Event listeners for real-time validation
    setupValidation();

    // Barcodes modal basic wiring
    try {
        const s1radios = document.querySelectorAll('input[name="bcS1Mode"]');
        const s2radios = document.querySelectorAll('input[name="bcS2Mode"]');
        const s3radios = document.querySelectorAll('input[name="bcS3Mode"]');
        const bind = (radios, prodId, locId, manId, previewId)=>{
            const setShow = (el, show)=>{
                if(!el) return;
                if (show) {
                    // Keep inline layout if container uses inline-row
                    el.style.display = el.classList.contains('inline-row') ? 'flex' : '';
                } else {
                    el.style.display = 'none';
                }
            };
            radios.forEach(r=> r.addEventListener('change', ()=>{
                const prod = document.getElementById(prodId);
                const loc = document.getElementById(locId);
                const man = document.getElementById(manId);
                if(!prod||!loc||!man) return;
                const mode = document.querySelector(`input[name="${r.name}"]:checked`)?.value;
                setShow(prod, mode==='product');
                setShow(loc, mode==='location');
                setShow(man, mode==='manual');
                // Update preview
                try {
                    const img = document.getElementById(previewId);
                    if (img) {
                        img.src = mode==='location' ? 'Location.svg' : 'Product.svg';
                        img.alt = mode.charAt(0).toUpperCase()+mode.slice(1)+ ' preview';
                    }
                } catch(e){}
                validateBarcodesForm();
            }));
        };
        bind(s1radios,'bcS1ProductFields','bcS1LocationFields','bcS1ManualFields','bcS1ModePreview');
        bind(s2radios,'bcS2ProductFields','bcS2LocationFields','bcS2ManualFields','bcS2ModePreview');
        bind(s3radios,'bcS3ProductFields','bcS3LocationFields','bcS3ManualFields','bcS3ModePreview');

        // Inputs change should re-validate
        document.querySelectorAll('#barcodesModal input, #barcodesModal select').forEach(el=>{
            el.addEventListener('input', validateBarcodesForm);
            el.addEventListener('change', validateBarcodesForm);
        });

    // Setup Barcodes modal autocompletes and validations
    setupBarcodesAutocompleteAndValidation();
    // Ensure initial button state reflects empty fields
    try { validateBarcodesForm(); } catch(_){}
    } catch(e) { /* modal may not be on this page */ }
});

// Temporary Analytics placeholder
function openAnalyticsAndRegisters(){
  try { window.location.href = 'features/logistics/deliveries-couriers.html'; } catch(e){}
}

// Debounce function to limit API calls
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// ==================== MODAL SEARCH ====================

function openSearchModal() {
    document.getElementById('searchModal').classList.remove('hidden');
    document.getElementById('productSearch').focus();
    resetSearchModal();
}

// Close the Product Search modal and clear its state
function closeSearchModal() {
    try {
        const modal = document.getElementById('searchModal');
        if (modal) modal.classList.add('hidden');
        resetSearchModal();
    } catch (_) { }
}

// Reset Product Search modal UI and internal state without changing global styles/behavior
function resetSearchModal() {
    try {
        // Clear input and messages
        const input = document.getElementById('productSearch');
        if (input) input.value = '';
        const resultsDiv = document.getElementById('searchResults');
        if (resultsDiv) resultsDiv.innerHTML = '';
        const err = document.getElementById('searchError');
        if (err) { err.textContent = ''; err.style.display = ''; }

        // Hide details and clear displayed fields
        const details = document.getElementById('productDetails');
        if (details) details.classList.add('hidden');
        const foundSku = document.getElementById('foundSku');
        if (foundSku) foundSku.textContent = '';
        const foundCode = document.getElementById('foundCode');
        if (foundCode) foundCode.textContent = '';

        // Reset qty/date, selected size and pages
        const qty = document.getElementById('editQty');
        if (qty) qty.value = '';
        const dateEl = document.getElementById('editDate');
        if (dateEl) {
            const today = getTodayLocalYMD();
            dateEl.value = today;
        }
        selectedProduct = null;
        selectedSearchSize = null;
        searchPages = 1;
        const pagesEl = document.getElementById('pagesCount');
        if (pagesEl) pagesEl.value = 1;
        // Unselect any size buttons inside search modal
        try {
            document.querySelectorAll('#searchModal .size-btn').forEach(btn => btn.classList.remove('selected'));
        } catch(_){}

        // Clear any validation errors and update print button state
        try { clearValidationErrors(); } catch(_){}
        try { updatePrintButton('search'); } catch(_){}
    } catch (_) { }
}

// Execute product search via Supabase and render results
async function performSearch() {
    try {
        const input = document.getElementById('productSearch');
        const resultsDiv = document.getElementById('searchResults');
        const err = document.getElementById('searchError');
        const term = (input?.value || '').trim();

        // Reset messages
        if (err) { err.textContent = ''; err.style.display = ''; }
        if (resultsDiv) resultsDiv.innerHTML = '';

        // Empty term: keep UI clean
        if (!term) {
            return;
        }

        if (resultsDiv) {
            resultsDiv.innerHTML = '<div class="loading">Searching…</div>';
        }

        // Ensure Supabase is ready
        try { await (window.supabaseReady || Promise.resolve()); } catch(_){}
        if (!window.supabaseSearch || typeof window.supabaseSearch.searchProduct !== 'function') {
            if (resultsDiv) resultsDiv.innerHTML = '';
            if (err) err.textContent = 'Search service unavailable';
            return;
        }

        const res = await window.supabaseSearch.searchProduct(term);
        if (res && res.success && Array.isArray(res.products) && res.products.length) {
            displaySearchResults(res.products);
            if (err) err.textContent = '';
        } else {
            if (resultsDiv) resultsDiv.innerHTML = '';
            if (err) err.textContent = (res && res.error) ? res.error : 'No products found';
            const details = document.getElementById('productDetails');
            if (details) details.classList.add('hidden');
        }
    } catch (e) {
        try {
            const err = document.getElementById('searchError');
            if (err) err.textContent = 'Search failed. Please try again.';
        } catch(_){}
        console.error('performSearch error', e);
    }
}

function printBarcodes3Up(){
    // Business rules enforcement:
    // - Product mode: do NOT check DB. Allow print when either SKU is exactly 5 digits OR EAN-13 is valid (13 digits). Name is optional and printed as title.
    // - Location mode: must exist in DB (kept, as locations are more constrained operationally).
    // - Manual mode: must have 5-digit code AND a valid 13-digit EAN-13.
    // - EAN-13 fields (product/manual) are valid only with 13 numeric digits; otherwise ignored (Product) or blocked (Manual) per above.
    try {
        const skuRegex = /^\d{5}$/;
        const eanRegex = /^\d{13}$/;
        const getMode = (name)=> document.querySelector(`input[name="${name}"]:checked`)?.value || 'product';

        const checkLocationInDB = async (loc)=>{
            if(!loc) return false;
            if(!window.supabaseSearch || !window.supabaseSearch.searchLocation) return false;
            try {
                const res = await window.supabaseSearch.searchLocation(loc);
                return !!(res && res.success && Array.isArray(res.locations) && res.locations.length > 0);
            } catch(e){ return false; }
        };

        const build = (n)=>({
            mode: getMode(`bcS${n}Mode`),
            product: {
                sku: document.getElementById(`bcS${n}ProdSku`)?.value?.trim() || '',
                name: document.getElementById(`bcS${n}ProdName`)?.value?.trim() || '',
                ean13: (document.getElementById(`bcS${n}ProdEan`)?.value || '').trim()
            },
            location: {
                code: document.getElementById(`bcS${n}LocCode`)?.value?.trim() || ''
            },
            manual: {
                code: document.getElementById(`bcS${n}ManCode`)?.value?.trim() || '',
                title: document.getElementById(`bcS${n}ManTitle`)?.value?.trim() || '',
                ean13: (document.getElementById(`bcS${n}ManEan`)?.value || '').trim()
            }
        });

        const raw = [build(1), build(2), build(3)];
        const finalSections = [];
        const errors = [];

        const locationCache = new Map();

        const ensureLocation = async (code)=>{
            if(locationCache.has(code)) return locationCache.get(code);
            const ok = await checkLocationInDB(code);
            locationCache.set(code, ok);
            return ok;
        };

        const tasks = raw.map(async (r, idx)=>{
            const i = idx+1;
            if(r.mode === 'product'){
                const { sku, name, ean13 } = r.product;
                const hasSku = sku && skuRegex.test(sku);
                const hasEan = ean13 && eanRegex.test(ean13);
                // If nothing filled in this section, skip silently
                if(!(sku||name||ean13)) { return; }
                // Require at least a barcodable identifier: EAN-13 or 5-digit SKU
                if(!hasSku && !hasEan){ errors.push(`Section ${i} (Product): provide a 5-digit SKU or a valid EAN-13.`); return; }
                finalSections.push({ mode:'product', sku: hasSku ? sku : '', name, ean13: hasEan ? ean13 : '' });
            } else if(r.mode === 'location') {
                const { code } = r.location;
                if(!code){ return; }
                const exists = await ensureLocation(code);
                if(!exists){ errors.push(`Section ${i} (Location): code not found.`); return; }
                finalSections.push({ mode:'location', location: code });
            } else if(r.mode === 'manual') {
                const { code, title, ean13 } = r.manual;
                if(!skuRegex.test(code)) { if(code||title||ean13) errors.push(`Section ${i} (Manual): code must be exactly 5 digits.`); return; }
                if(!eanRegex.test(ean13)) { errors.push(`Section ${i} (Manual): EAN-13 must be exactly 13 digits.`); return; }
                finalSections.push({ mode:'manual', code, title, ean13 });
            }
        });

        Promise.all(tasks).then(()=>{
            // Block printing if there are any errors
            if(errors.length){
                const msg = errors.join('\n');
                try { toast(msg,'error'); } catch(_) { alert(msg); }
                return;
            }
            // If no errors but nothing valid to print, inform and stop
            if(!finalSections.length){
                const msg = 'Nothing to print';
                try { toast(msg,'warn'); } catch(_) { alert(msg); }
                return;
            }
            const payload = { sections: finalSections };
            const w = window.open('barcodes_labels.html', '_blank');
            if (!w) { try { toast('Popup blocked','error'); } catch(_) { alert('Popup blocked'); } return; }
            const onReady = (e)=>{
                if (e.data === 'BARCODES_READY'){
                    try { w.postMessage({ type:'BARCODES_DATA', payload }, '*'); } catch(err){}
                    // Clear modal after initiating print
                    try { resetBarcodesModal(); } catch(_){}
                    window.removeEventListener('message', onReady);
                }
            };
            window.addEventListener('message', onReady);
        });
    } catch (e) {
        console.error('Print error', e);
        try { toast('Print error: '+ (e.message||'unknown'),'error'); } catch(_) { alert('Print error: ' + e.message); }
    }
}
// (Removed stray duplicated search error block accidentally inserted after printBarcodes3Up)

// Display search results
function displaySearchResults(results) {
    const resultsDiv = document.getElementById('searchResults');
    
    let html = '<div class="search-results-list">';
    results.forEach(product => {
        // Usa as propriedades maiúsculas do banco
        html += `
            <div class="search-result-item" onclick="selectProduct('${product.SKU}', '${product.Code}')">
                <div class="result-sku">📦 ${product.SKU}</div>
                <div class="result-code">🏷️ ${product.Code}</div>
            </div>
        `;
    });
    html += '</div>';
    
    resultsDiv.innerHTML = html;
}

// Select a product from search results
async function selectProduct(sku, code) {
    try {
        // Get complete product details using both SKU and Code to identify the correct product
        const result = await window.supabaseSearch.searchBySKUAndCode(sku, code);
        
        if (!result.success) {
            document.getElementById('searchError').textContent = result.error || '❌ Product not found';
            return;
        }
        
        selectedProduct = result.product;
        
        // Fill product details
        document.getElementById('foundSku').textContent = result.product.sku;
        document.getElementById('foundCode').textContent = result.product.code;
        
        // Fill default QTY if available
        if (result.product.qty) {
            document.getElementById('editQty').value = result.product.qty;
        }
        
        // Show details section
        document.getElementById('productDetails').classList.remove('hidden');
        document.getElementById('searchResults').innerHTML = '';
        
        // Focus on QTY field
        document.getElementById('editQty').focus();
        
        updatePrintButton('search');
        
    } catch (error) {
        console.error('Error selecting product:', error);
        document.getElementById('searchError').textContent = '❌ Error loading product details';
    }
}

// Search product (search button)
async function searchProduct() {
    await performSearch();
}

// ==================== MODAL MANUAL ====================

function openManualModal() {
    console.log('🔧 Opening manual modal...');
    const modal = document.getElementById('manualModal');
    const skuField = document.getElementById('manualSku');
    
    if (!modal) {
        console.error('❌ Manual modal not found!');
        return;
    }
    
    if (!skuField) {
        console.error('❌ Manual SKU field not found!');
        return;
    }
    
    modal.classList.remove('hidden');
    console.log('✅ Modal opened, focusing on SKU field...');
    
    // Small delay to ensure modal is visible before focusing
    setTimeout(() => {
        skuField.focus();
        console.log('✅ SKU field focused');
    }, 100);
    
    resetManualModal();
}

function closeManualModal() {
    document.getElementById('manualModal').classList.add('hidden');
    resetManualModal();
}

function resetManualModal() {
    document.getElementById('manualForm').reset();
    
    // Reset data para hoje (using local timezone)
    const today = getTodayLocalYMD();
    document.getElementById('manualDate').value = today;
    
    selectedManualSize = null;
    manualPages = 1;
    document.getElementById('manualPagesCount').value = 1;
    updateSizeButtons('manual');
    updatePrintButton('manual');
    clearValidationErrors();
}

// ==================== SIZE SELECTION ====================

function selectSize(size) {
    selectedSearchSize = size;
    updateSizeButtons('search');
    updatePrintButton('search');
}

function selectManualSize(size) {
    selectedManualSize = size;
    updateSizeButtons('manual');
    updatePrintButton('manual');
}

function updateSizeButtons(modal) {
    const prefix = modal === 'search' ? '' : 'manual';
    const selectedSize = modal === 'search' ? selectedSearchSize : selectedManualSize;
    
    document.querySelectorAll(`#${modal}Modal .size-btn`).forEach(btn => {
        btn.classList.remove('selected');
        btn.setAttribute('aria-pressed', 'false');
        if (btn.dataset.size === selectedSize) {
            btn.classList.add('selected');
            btn.setAttribute('aria-pressed', 'true');
        }
    });
}

// ==================== PAGES CONTROL ====================

function increasePages() {
    searchPages++;
    document.getElementById('pagesCount').value = searchPages;
    updatePrintButton('search');
}

function decreasePages() {
    if (searchPages > 1) {
        searchPages--;
        document.getElementById('pagesCount').value = searchPages;
        updatePrintButton('search');
    }
}

function increaseManualPages() {
    manualPages++;
    document.getElementById('manualPagesCount').value = manualPages;
    updatePrintButton('manual');
}

function decreaseManualPages() {
    if (manualPages > 1) {
        manualPages--;
        document.getElementById('manualPagesCount').value = manualPages;
        updatePrintButton('manual');
    }
}

// ==================== VALIDATION ====================

function setupValidation() {
    // Real-time validation for required fields
    const requiredFields = ['editQty', 'manualSku', 'manualCode', 'manualQty'];
    
    requiredFields.forEach(fieldId => {
        const field = document.getElementById(fieldId);
        if (field) {
            field.addEventListener('input', () => {
                validateField(fieldId);
                const modal = fieldId.includes('manual') ? 'manual' : 'search';
                updatePrintButton(modal);
            });
        }
    });
    
    // Special handling for SKU field - only allow numbers and limit to 5 digits
    const skuField = document.getElementById('manualSku');
    if (skuField) {
        skuField.addEventListener('input', function(e) {
            // Remove non-numeric characters
            this.value = this.value.replace(/[^0-9]/g, '');
            // Limit to 5 characters
            if (this.value.length > 5) {
                this.value = this.value.slice(0, 5);
            }
        });
    }
    
    // Special handling for QTY fields - limit to 5 digits (max 99999)
    // Para type=number, não precisa JS para bloquear letras, o input já faz isso
    // Só adiciona validação visual e alerta no submit
}

function validateField(fieldId) {
    const field = document.getElementById(fieldId);
    const errorDiv = document.getElementById(fieldId + 'Error');
    
    if (!field) return true;
    
    let isValid = true;
    let errorMessage = '';
    
    if (field.hasAttribute('required') && !field.value.trim() && fieldId !== 'editQty' && fieldId !== 'manualQty') {
        isValid = false;
        errorMessage = 'This field is required';
    } else if (field.type === 'number' && field.value && parseInt(field.value) < 1 && fieldId !== 'editQty') {
        isValid = false;
        errorMessage = 'Must be greater than 0';
    } else if (field.type === 'number' && field.value && parseInt(field.value) > 99999) {
        isValid = false;
        errorMessage = 'Must be 99999 or less';
    } else if (fieldId === 'manualSku') {
        // Special validation for SKU: exactly 5 digits
        const skuValue = field.value.trim();
        if (skuValue && (!/^\d{5}$/.test(skuValue))) {
            isValid = false;
            errorMessage = 'SKU must be exactly 5 digits';
        }
    } else if (fieldId === 'editQty' || fieldId === 'manualQty') {
        // Show error if not a valid number
        if (field.value && !/^\d+$/.test(field.value)) {
            isValid = false;
            errorMessage = 'Only numbers are allowed';
        }
    }
    
    if (errorDiv) {
        errorDiv.textContent = errorMessage;
        errorDiv.style.display = errorMessage ? 'block' : 'none';
    }
    
    field.classList.toggle('error', !isValid);
    
    return isValid;
}

function validateSearchForm() {
    // Require a selected product and paper size
    if (!selectedProduct) return false;
    if (!selectedSearchSize) return false;
    return true;
}

function validateManualForm() {
    const fields = ['manualSku', 'manualCode', 'manualQty'];
    let isValid = true;
    
    fields.forEach(fieldId => {
        if (!validateField(fieldId)) {
            isValid = false;
        }
    });
    
    // Require paper size selection for proper formatting
    if (!selectedManualSize) isValid = false;
    // manualQty can be 0 or empty
    
    return isValid;
}

function clearValidationErrors() {
    document.querySelectorAll('.error').forEach(el => {
        el.textContent = '';
        el.style.display = 'none';
    });
    
    document.querySelectorAll('input.error').forEach(input => {
        input.classList.remove('error');
    });
}

// ==================== PRINT BUTTON CONTROL ====================

function updatePrintButton(modal) {
    let isValid = false;
    let buttonId = '';
    
    if (modal === 'search') {
        isValid = validateSearchForm();
        buttonId = 'printSearchBtn';
    } else {
        isValid = validateManualForm();
        buttonId = 'printManualBtn';
    }
    
    const button = document.getElementById(buttonId);
    if (button) {
        button.classList.toggle('disabled', !isValid);
        button.disabled = !isValid;
    }
}

// ==================== PRINT FUNCTIONS ====================

function printSearchLabel() {
    if (!validateSearchForm()) {
        alert('Please fill all required fields correctly.');
        return;
    }
    
    const labelData = {
        sku: selectedProduct.sku,
        code: selectedProduct.code,
        qty: document.getElementById('editQty').value,
        date: document.getElementById('editDate').value,
        size: selectedSearchSize,
        pages: searchPages
    };
    
    generateAndPrintLabel(labelData);
}

function handleManualSubmit(e) {
    e.preventDefault();
    
    if (!validateManualForm()) {
        alert('Please fill all required fields correctly.');
        return;
    }
    
    const labelData = {
        sku: document.getElementById('manualSku').value,
        code: document.getElementById('manualCode').value.toUpperCase(),
        qty: document.getElementById('manualQty').value,
        date: document.getElementById('manualDate').value,
        size: selectedManualSize,
        pages: manualPages
    };
    
    generateAndPrintLabel(labelData);
}

function generateAndPrintLabel(labelData) {
    try {
        const labelHTML = generateLabelHTML(labelData);
        const printWindow = window.open('', '_blank');
        printWindow.document.write(labelHTML);
        printWindow.document.close();
        // Let the child window manage dynamic readiness & printing internally
        printWindow.onload = function() {
            try { console.log('Print window loaded; internal script will auto-print when barcodes are ready.'); } catch(e){}
        };
        
        // Fecha o modal após imprimir
        if (document.getElementById('searchModal').classList.contains('hidden') === false) {
            closeSearchModal();
        }
        if (document.getElementById('manualModal').classList.contains('hidden') === false) {
            closeManualModal();
        }
        
    } catch (error) {
        console.error('Print error:', error);
        alert('Error generating label. Please try again.');
    }
}

function generateLabelHTML(labelData) {
    const { sku, code, qty, date } = labelData;
    // Default size to A4 unless explicitly A3
    const size = (labelData && labelData.size === 'A3') ? 'A3' : 'A4';
    
    let pagesHTML = '';
    for (let i = 1; i <= labelData.pages; i++) {
        pagesHTML += `
            <div class="label-page">
                <div class="label-content">
                    <div class="sku-line">
                        <div class="sku-left">
                            <span class="sku-label">SKU:</span>
                            <span class="sku-value">${sku}</span>
                        </div>
                        <div class="sku-barcode-right">
                            <svg class="barcode"></svg>
                        </div>
                    </div>
                    <div class="code-line">
                        <span class="code-label">Code:</span>
                        <span class="code-value">${code}</span>
                    </div>
                    <div class="qty-line">
                        <div class="qty-left">
                            <span class="qty-label">QTY:</span>
                            <span class="qty-value">${qty}</span>
                        </div>
                        <div class="qty-date-right">
                            ${date ? `<span class="date-value">${formatDateForLabel(date)}</span>` : ''}
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    return `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Label - ${sku}</title>
            <!-- JsBarcode Library for barcode generation - load synchronously -->
            <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js"></script>
            <script>
                // Ensure library is loaded
                console.log('JsBarcode loaded:', typeof JsBarcode !== 'undefined');
            </script>
            <style>
                @page {
                    margin: 0;
                    size: ${size === 'A3' ? 'A3 landscape' : 'A4 landscape'};
                }
                
                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                }
                
                body {
                    margin: 0;
                    padding: 20mm;
                    font-family: Arial, sans-serif;
                    line-height: 1;
                }
                
                body.a4-mode {
                    width: 297mm;
                    height: 210mm;
                }
                
                body.a3-mode {
                    width: 420mm;
                    height: 297mm;
                }
                
                .label-page {
                    width: 100%;
                    height: 100%;
                    display: flex;
                    align-items: flex-start;
                    justify-content: flex-start;
                    page-break-inside: avoid;
                }
                
                .label-content {
                    width: 100%;
                    text-align: left;
                }
                
                .sku-line, .code-line {
                    display: block;
                    margin-bottom: 15mm;
                    text-align: left;
                }
                
                .sku-line {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    width: 100%;
                }
                
                .sku-left {
                    display: flex;
                    align-items: baseline;
                    flex: 1;
                }
                
                .sku-barcode-right {
                    flex-shrink: 0;
                    text-align: right;
                }
                
                .qty-line {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 15mm;
                    width: 100%;
                }
                
                .qty-left {
                    display: flex;
                    align-items: baseline;
                    flex: 1;
                }
                
                .qty-date-right {
                    flex-shrink: 0;
                    text-align: right;
                }
                
                /* A4 Styles */
                body.a4-mode .sku-label,
                body.a4-mode .code-label,
                body.a4-mode .qty-label {
                    font-size: 40px;
                    font-weight: bold;
                }
                
                body.a4-mode .date-value {
                    font-size: 42px;
                    font-weight: bold;
                }
                
                body.a4-mode .sku-value {
                    font-size: 180px;
                    margin-left: 20px;
                }
                
                body.a4-mode .code-value {
                    font-size: 90px;
                    margin-left: 20px;
                    max-width: 80%;
                    word-break: break-word;
                }
                
                body.a4-mode .qty-value {
                    font-size: 160px;
                    margin-left: 20px;
                }
                
                body.a4-mode .barcode {
                    height: 120px;
                    max-width: 300px;
                }
                
                /* A3 Styles */
                body.a3-mode .sku-label,
                body.a3-mode .code-label,
                body.a3-mode .qty-label {
                    font-size: 80px;
                    font-weight: bold;
                }
                
                body.a3-mode .date-value {
                    font-size: 75px;
                    font-weight: bold;
                }
                
                body.a3-mode .sku-value {
                    font-size: 220px;
                    margin-left: 30px;
                }
                
                body.a3-mode .code-value {
                    font-size: 150px;
                    margin-left: 30px;
                    max-width: 80%;
                    word-break: break-word;
                }
                
                body.a3-mode .qty-value {
                    font-size: 200px;
                    margin-left: 30px;
                }
                
                body.a3-mode .barcode {
                    height: 150px;
                    max-width: 400px;
                }
                
                @media print {
                    body { margin: 0; padding: 20mm; }
                    .label-page { 
                        margin: 0 !important;
                        page-break-inside: avoid;
                    }
                }
            </style>
        </head>
        <body class="${size.toLowerCase()}-mode">
            ${pagesHTML}
            
            <script>
                // Generate barcodes after page loads with proper timing
                function generateBarcodes() {
                    // Check if JsBarcode is loaded
                    if (typeof JsBarcode === 'undefined') {
                        // If not loaded, wait a bit and try again
                        setTimeout(generateBarcodes, 100);
                        return;
                    }
                    
                    // Find all barcode elements by class instead of ID to avoid duplicates
                    const barcodeElements = document.querySelectorAll('.barcode');
                    console.log('Found', barcodeElements.length, 'barcode elements');
                    
                    barcodeElements.forEach(function(barcodeElement, index) {
                        if (barcodeElement) {
                            try {
                                JsBarcode(barcodeElement, "${code}", {
                                    format: "CODE128",
                                    width: 3,
                                    height: ${size === 'A3' ? '150' : '120'},
                                    displayValue: true,
                                    fontSize: 16,
                                    textAlign: "center",
                                    textPosition: "bottom",
                                    background: "#ffffff",
                                    lineColor: "#000000"
                                });
                                console.log('Barcode generated for element', index);
                            } catch (error) {
                                console.error('Error generating barcode for element', index, error);
                            }
                        }
                    });
                    if (!window.__wfStarted) { window.__wfStarted = true; waitForBarcodes(performance.now()); }
                }
                
                function allBarcodesReady() {
                    const svgs = document.querySelectorAll('.barcode');
                    if (!svgs.length) return false;
                    return [...svgs].every(svg => svg.childElementCount > 0 || svg.querySelector('rect,g'));
                }
                
                function waitForBarcodes(startTs) {
                    if (allBarcodesReady()) {
                        if (!window.__printed) {
                            window.__printed = true;
                            console.log('All barcodes ready -> printing');
                            try { window.focus(); } catch(e){}
                            window.print();
                            window.onafterprint = function(){ try { window.close(); } catch(e){} };
                        }
                        return;
                    }
                    const elapsed = performance.now() - startTs;
                    if (elapsed > 5000) { // fallback after 5s
                        console.warn('Timeout waiting for barcodes, proceeding to print');
                        if (!window.__printed) {
                            window.__printed = true;
                            try { window.focus(); } catch(e){}
                            window.print();
                            window.onafterprint = function(){ try { window.close(); } catch(e){} };
                        }
                        return;
                    }
                    setTimeout(() => waitForBarcodes(startTs), 120);
                }
                
                // Start generation when page loads
                window.onload = function() {
                    console.log('Page loaded, starting barcode generation...');
                    generateBarcodes();
                };
                
                // Fallback: also try after DOM is ready
                document.addEventListener('DOMContentLoaded', function() {
                    console.log('DOM ready, ensuring barcodes are generated...');
                    setTimeout(generateBarcodes, 200);
                });
            </script>
        </body>
        </html>
    `;
}

function formatDateForLabel(dateStr) {
    let date;
    if (!dateStr) {
        date = new Date();
    } else {
        date = new Date(dateStr);
    }
    
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = String(date.getFullYear()).slice(-2);
    
    return `${day}/${month}/${year}`;
}

function formatDate(dateStr) {
    if (!dateStr) return new Date().toLocaleDateString();
    
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit'
    });
}

// ==================== KEYBOARD SHORTCUTS ====================

document.addEventListener('keydown', function(e) {
    // ESC to close modals
    if (e.key === 'Escape') {
        if (!document.getElementById('searchModal').classList.contains('hidden')) {
            closeSearchModal();
        }
        if (!document.getElementById('manualModal').classList.contains('hidden')) {
            closeManualModal();
        }
    }
    
    // Ctrl+P to print (if modal is open)
    if (e.ctrlKey && e.key === 'p') {
        e.preventDefault();
        
        if (!document.getElementById('searchModal').classList.contains('hidden')) {
            if (validateSearchForm()) {
                printSearchLabel();
            }
        } else if (!document.getElementById('manualModal').classList.contains('hidden')) {
            if (validateManualForm()) {
                handleManualSubmit(e);
            }
        }
    }
});

// (Collections logic removed – now centralized in collections.js to avoid duplication.)

// ==================== MODAL BARCODES (3-UP) ====================
function openBarcodesModal(){
    try {
        resetBarcodesModal();
        document.getElementById('barcodesModal').classList.remove('hidden');
    } catch(e){}
}
function closeBarcodesModal(){
    try {
        document.getElementById('barcodesModal').classList.add('hidden');
        resetBarcodesModal();
    } catch(e){}
}

function resetBarcodesModal(){
    try {
        const modal = document.getElementById('barcodesModal');
        if (!modal) return;

        // Clear all inputs and error styles
        const clearIds = [
            'bcS1ProdSku','bcS1ProdName','bcS1ProdEan','bcS1LocCode','bcS1ManCode','bcS1ManTitle','bcS1ManEan',
            'bcS2ProdSku','bcS2ProdName','bcS2ProdEan','bcS2LocCode','bcS2ManCode','bcS2ManTitle','bcS2ManEan',
            'bcS3ProdSku','bcS3ProdName','bcS3ProdEan','bcS3LocCode','bcS3ManCode','bcS3ManTitle','bcS3ManEan'
        ];
        clearIds.forEach(id=>{ const el=document.getElementById(id); if(el){ el.value=''; el.classList.remove('error'); } });

        // Reset inline error notes
        ['bcS1ManCodeErr','bcS1ManEanErr','bcS2ManCodeErr','bcS2ManEanErr','bcS3ManCodeErr','bcS3ManEanErr']
            .forEach(id=>{ const el=document.getElementById(id); if(el){ el.textContent=''; el.style.display='none'; } });

        // Reset mode radios to product and trigger change to update visible sections
        ['1','2','3'].forEach(n=>{
            const radios = document.querySelectorAll(`input[name="bcS${n}Mode"]`);
            radios.forEach(r=>{ r.checked = (r.value === 'product'); });
            const productRadio = Array.from(radios).find(r=> r.value === 'product');
            if (productRadio){ productRadio.dispatchEvent(new Event('change', { bubbles:true })); }
            const img = document.getElementById(`bcS${n}ModePreview`);
            if (img){ img.src = 'Product.svg'; img.alt = 'Product preview'; }
        });

        // Close any autocomplete panels
        modal.querySelectorAll('.ac-panel').forEach(p=>{ try{ p.remove(); }catch(_){} });

        // Disable Print button
        const btn = document.getElementById('bcPrintBtn');
        if (btn) btn.disabled = true;

        try { validateBarcodesForm(); } catch(_){}
    } catch(e){}
}

function validateBarcodesForm(){
    const hasData = ()=>{
        // Section 1
        const m1 = document.querySelector('input[name="bcS1Mode"]:checked')?.value;
        if(m1==='product' && (document.getElementById('bcS1ProdName')?.value || document.getElementById('bcS1ProdSku')?.value || document.getElementById('bcS1ProdEan')?.value)) return true;
        if(m1==='location' && (document.getElementById('bcS1LocCode')?.value)) return true;
    if(m1==='manual' && (document.getElementById('bcS1ManTitle')?.value || document.getElementById('bcS1ManCode')?.value || document.getElementById('bcS1ManEan')?.value)) return true;
        // Section 2
        const m2 = document.querySelector('input[name="bcS2Mode"]:checked')?.value;
        if(m2==='product' && (document.getElementById('bcS2ProdName')?.value || document.getElementById('bcS2ProdSku')?.value || document.getElementById('bcS2ProdEan')?.value)) return true;
        if(m2==='location' && (document.getElementById('bcS2LocCode')?.value)) return true;
    if(m2==='manual' && (document.getElementById('bcS2ManTitle')?.value || document.getElementById('bcS2ManCode')?.value || document.getElementById('bcS2ManEan')?.value)) return true;
        // Section 3
        const m3 = document.querySelector('input[name="bcS3Mode"]:checked')?.value;
        if(m3==='product' && (document.getElementById('bcS3ProdName')?.value || document.getElementById('bcS3ProdSku')?.value || document.getElementById('bcS3ProdEan')?.value)) return true;
        if(m3==='location' && (document.getElementById('bcS3LocCode')?.value)) return true;
    if(m3==='manual' && (document.getElementById('bcS3ManTitle')?.value || document.getElementById('bcS3ManCode')?.value || document.getElementById('bcS3ManEan')?.value)) return true;
        return false;
    };
    const btn = document.getElementById('bcPrintBtn');
    if(btn) btn.disabled = !hasData();
}

// (Old printBarcodes3Up removed; new implementation with validation inserted later in file.)

// ----- Zebra helpers -----
function getZebraConfig(){
    // Default Zebra at 203 dpi (8 dots/mm). If your printer is 300dpi, set dpi to 300.
    const dpi = 203;
    const dotsPerMm = dpi / 25.4; // ~8 for 203dpi
    const mm = (v)=> Math.round(v * dotsPerMm);
    return {
        dpi,
        mm,
        // Full sticker: 150mm x 105mm
        widthDots: mm(150),
        heightDots: mm(105),
        // 3 sections: each ~35mm height x 100mm width, centered
        section: {
            widthDots: mm(100),
            heightDots: mm(35),
            leftMarginDots: Math.round((mm(150) - mm(100)) / 2),
            topOffsets: [ 0, mm(35), mm(70) ]
        } 
    };
}

function zplEscape(text){
    return String(text||'').replace(/[\^~]/g, ' ').slice(0, 64); // keep short for small labels
}

function buildSectionPayload(n){
    // n = 1..3
    const mode = document.querySelector(`input[name="bcS${n}Mode"]:checked`)?.value;
    if (!mode) return null;
    if (mode === 'product'){
        const sku = document.getElementById(`bcS${n}ProdSku`)?.value?.trim();
        const name = document.getElementById(`bcS${n}ProdName`)?.value?.trim();
        if (!sku && !name) return null;
        return {
            title: name || '',
            big: sku || '',
            barcode: sku || '',
            barcodeType: 'CODE128'
        };
    }
    if (mode === 'location'){
        const loc = document.getElementById(`bcS${n}LocCode`)?.value?.trim();
        if (!loc) return null;
        return {
            title: '',
            big: loc,
            barcode: loc,
            barcodeType: 'CODE128'
        };
    }
    // manual
    const code = document.getElementById(`bcS${n}ManCode`)?.value?.trim();
    const title = document.getElementById(`bcS${n}ManTitle`)?.value?.trim();
    const ean = (document.getElementById(`bcS${n}ManEan`)?.value||'').trim();
    if (!code && !ean && !title) return null;
    return {
        title: title || '',
        big: code || '',
        barcode: ean || code || '',
        barcodeType: ean && ean.length === 13 ? 'EAN13' : 'CODE128'
    };
}

function buildZpl3Up(sections, cfg){
    const { widthDots, heightDots, section } = cfg;
    const lines = [];
    lines.push('^XA');
    lines.push('^CI28'); // UTF-8
    lines.push(`^PW${widthDots}`);
    lines.push(`^LL${heightDots}`);
    lines.push('^LH0,0');
    // Default barcode module width
    lines.push('^BY2,2');

    sections.forEach((s, idx)=>{
        if (!s) return;
        const x0 = section.leftMarginDots;
        const y0 = section.topOffsets[idx];
        // Title (small)
        if (s.title){
            lines.push(`^FO${x0},${y0+8}`);
            lines.push('^A0N,30,20');
            lines.push(`^FD${zplEscape(s.title)}^FS`);
        }
        // Big text
        if (s.big){
            lines.push(`^FO${x0},${y0+44}`);
            lines.push('^A0N,80,60');
            lines.push(`^FD${zplEscape(s.big)}^FS`);
        }
        // Barcode
        if (s.barcode){
            const byH = 130; // bar height in dots (~16mm at 203dpi)
            lines.push(`^FO${x0},${y0+128}`);
            if (s.barcodeType === 'EAN13'){
                lines.push(`^BEN,${byH},Y,N,N`);
            } else {
                lines.push(`^BCN,${byH},Y,N,N`);
            }
            lines.push(`^FD${zplEscape(s.barcode)}^FS`);
        }
        // Thin separator line at bottom of section (except last)
        if (idx < 2){
            lines.push(`^FO${cfg.mm(25)},${section.topOffsets[idx]+section.heightDots-2}`);
            lines.push('^GB'+cfg.mm(100)+',2,2^FS');
        }
    });

    lines.push('^PQ1'); // 1 copy
    lines.push('^XZ');
    return lines.join('');
}

async function sendZplToPrinter(zpl){
    const resp = await fetch('/api/print-zpl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zpl })
    });
    if (!resp.ok){
        const txt = await resp.text().catch(()=> '');
        throw new Error(`Printer error (${resp.status}): ${txt || resp.statusText}`);
    }
    return resp.json();
}

// ==================== BARCODES AUTOCOMPLETE & VALIDATION ====================
function setupBarcodesAutocompleteAndValidation(){
    // Manual field validation (digits & length constraints)
    const manSkuIds = ['bcS1ManCode','bcS2ManCode','bcS3ManCode'];
    const manSkuErrIds = ['bcS1ManCodeErr','bcS2ManCodeErr','bcS3ManCodeErr'];
    const manEanIds = ['bcS1ManEan','bcS2ManEan','bcS3ManEan'];
    const manEanErrIds = ['bcS1ManEanErr','bcS2ManEanErr','bcS3ManEanErr'];
    manSkuIds.forEach((id, i)=>{
        const input = document.getElementById(id);
        const err = document.getElementById(manSkuErrIds[i]);
    if (input){
            input.addEventListener('input', ()=>{
                // digits only, max 5
                const raw = input.value.replace(/\D+/g,'');
                input.value = raw.slice(0,5);
                if (input.value && input.value.length < 5){
            if (err){ err.textContent = 'Must be 5 digits'; err.style.display = 'block'; }
            input.classList.add('error');
                } else {
            if (err){ err.textContent = ''; err.style.display = 'none'; }
            input.classList.remove('error');
                }
            });
        }
    });
    manEanIds.forEach((id, i)=>{
        const input = document.getElementById(id);
        const err = document.getElementById(manEanErrIds[i]);
    if (input){
            input.addEventListener('input', ()=>{
                // digits only, max 13
                const raw = input.value.replace(/\D+/g,'');
                input.value = raw.slice(0,13);
                if (input.value && input.value.length < 13){
            if (err){ err.textContent = 'Must be 13 digits'; err.style.display = 'block'; }
            input.classList.add('error');
                } else {
            if (err){ err.textContent = ''; err.style.display = 'none'; }
            input.classList.remove('error');
                }
            });
        }
    });

    // Product autocomplete (Name & SKU), threshold 3
    const prodPairs = [
        { nameId:'bcS1ProdName', skuId:'bcS1ProdSku' },
        { nameId:'bcS2ProdName', skuId:'bcS2ProdSku' },
        { nameId:'bcS3ProdName', skuId:'bcS3ProdSku' },
    ];
    prodPairs.forEach(pair=>{
        attachProductAutocomplete(pair.nameId, pair.skuId);
        attachProductAutocomplete(pair.skuId, pair.nameId);
    });

    // Location autocomplete, threshold 4, scroll panel showing ~5 items height
    const locIds = ['bcS1LocCode','bcS2LocCode','bcS3LocCode'];
    locIds.forEach(id=> attachLocationAutocomplete(id));
}

function ensureAcPanel(container){
    let panel = container.querySelector('.ac-panel');
    if (!panel){
        panel = document.createElement('div');
        panel.className = 'ac-panel';
        container.appendChild(panel);
    }
    return panel;
}

function closeAcPanel(panel){ if (panel){ try{ panel.remove(); }catch(e){} } }

function renderSuggestions(panel, items, render){
    panel.innerHTML = '';
    items.forEach(item=>{
        const row = document.createElement('div');
        row.className = 'ac-item';
        row.innerHTML = render(item);
        panel.appendChild(row);
    });
}

function attachProductAutocomplete(srcInputId, otherInputId){
    const srcInput = document.getElementById(srcInputId);
    const otherInput = document.getElementById(otherInputId);
    if (!srcInput) return;
    const handler = debounce(async () => {
        const term = String(srcInput.value || '').trim();
        if (term.length < 3){
            const fg = srcInput.closest('.field-group');
            if (fg){ const p=fg.querySelector('.ac-panel'); if(p) p.remove(); }
            return;
        }
        try{
            if (!window.supabaseSearch || !window.supabaseSearch.searchBarcodes) return;
            const res = await window.supabaseSearch.searchBarcodes(term);
            if (!res || !res.success || !Array.isArray(res.items)) return;
            // Map suggestions
            const items = res.items.map(p=>({
                sku: p.sku || '',
                product: p.product || '',
                barcode: p.barcode || ''
            }));
            const fg = srcInput.closest('.field-group');
            if (!fg) return;
            const panel = ensureAcPanel(fg);
            renderSuggestions(panel, items, (it)=>{
                const left = it.sku ? `SKU ${it.sku}` : '';
                const right = it.product ? `${it.product}` : '';
                return `<div class="ac-left">${escapeHtml(left)}</div><div class="ac-right">${escapeHtml(right)}</div>`;
            });
            panel.querySelectorAll('.ac-item').forEach((row, idx)=>{
                row.addEventListener('mousedown', (e)=>{
                    e.preventDefault();
                    const it = items[idx];
                    // Fill fields
                    if (srcInputId.toLowerCase().includes('name')){
                        srcInput.value = it.product || '';
                        if (otherInput) otherInput.value = it.sku || '';
                    } else {
                        srcInput.value = it.sku || '';
                        if (otherInput) otherInput.value = it.product || '';
                    }
                    // Also store EAN in hidden field if present
                    try {
                        const hidId = srcInputId.replace(/(ProdSku|ProdName)$/,'ProdEan');
                        const hidden = document.getElementById(hidId);
                        if (hidden){ hidden.value = (it.barcode||'').replace(/\D+/g,''); }
                    } catch(_){}
                    try{ panel.remove(); }catch(err){}
                    validateBarcodesForm();
                });
            });
            // Close on blur/esc
            const onBlur = (ev)=>{ setTimeout(()=>{ try{ panel.remove(); }catch(e){} }, 80); };
            srcInput.addEventListener('blur', onBlur, { once:true });
        } catch(e){ /* ignore */ }
    }, 220);
    srcInput.addEventListener('input', handler);
}

function attachLocationAutocomplete(inputId){
    const input = document.getElementById(inputId);
    if (!input) return;
    const handler = debounce(async () => {
        const term = String(input.value || '').trim();
        if (term.length < 4){
            const fg = input.closest('.field-group');
            if (fg){ const p=fg.querySelector('.ac-panel'); if(p) p.remove(); }
            return;
        }
        try{
            if (!window.supabaseSearch || !window.supabaseSearch.searchLocation) return;
            const res = await window.supabaseSearch.searchLocation(term);
            if (!res || !res.success || !Array.isArray(res.locations)) return;
            // Limit rendering count if needed; panel height caps to ~5 rows, scrollable
            const items = res.locations;
            const fg = input.closest('.field-group');
            if (!fg) return;
            const panel = ensureAcPanel(fg);
            renderSuggestions(panel, items, (it)=>{
                const code = it.code || it.Code || it.location || it.Location || '';
                return `<div class="ac-left">${escapeHtml(code)}</div>`;
            });
            panel.querySelectorAll('.ac-item').forEach((row, idx)=>{
                row.addEventListener('mousedown', (e)=>{
                    e.preventDefault();
                    const it = items[idx];
                    const code = it.code || it.Code || it.location || it.Location || '';
                    input.value = code;
                    try{ panel.remove(); }catch(err){}
                    validateBarcodesForm();
                });
            });
            const onBlur = (ev)=>{ setTimeout(()=>{ try{ panel.remove(); }catch(e){} }, 80); };
            input.addEventListener('blur', onBlur, { once:true });
        } catch(e){ /* ignore */ }
    }, 240);
    input.addEventListener('input', handler);
}

function escapeHtml(s){
    return String(s||'').replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;' }[c]));
}
