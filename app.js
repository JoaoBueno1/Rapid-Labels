// Global variables
let selectedSearchSize = null;
let selectedManualSize = null;
let searchPages = 1;
let manualPages = 1;
let selectedProduct = null;

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
    
    // Set current date as default
    const today = new Date().toISOString().split('T')[0];
    const editDateInput = document.getElementById('editDate');
    const manualDateInput = document.getElementById('manualDate');
    
    if (editDateInput) editDateInput.value = today;
    if (manualDateInput) manualDateInput.value = today;
    
    // Event listeners for manual form
    const manualForm = document.getElementById('manualForm');
    if (manualForm) {
        manualForm.addEventListener('submit', handleManualSubmit);
    }
    
    // Event listener for real-time search
    const searchInput = document.getElementById('productSearch');
    if (searchInput) {
        searchInput.addEventListener('input', debounce(performSearch, 300));
        searchInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                searchProduct();
            }
        });
    }
    
    // Event listeners for real-time validation
    setupValidation();
});

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

function closeSearchModal() {
    document.getElementById('searchModal').classList.add('hidden');
    resetSearchModal();
}

function resetSearchModal() {
    document.getElementById('productSearch').value = '';
    document.getElementById('searchResults').innerHTML = '';
    document.getElementById('searchError').textContent = '';
    document.getElementById('productDetails').classList.add('hidden');
    document.getElementById('editQty').value = '';
    selectedSearchSize = null;
    searchPages = 1;
    document.getElementById('pagesCount').value = 1;
    updateSizeButtons('search');
    updatePrintButton('search');
    selectedProduct = null;
}

// Real-time search as user types
async function performSearch() {
    const searchTerm = String(document.getElementById('productSearch').value.trim());
    const resultsDiv = document.getElementById('searchResults');
    const errorDiv = document.getElementById('searchError');
    
    // Clear previous results
    resultsDiv.innerHTML = '';
    errorDiv.textContent = '';
    
    if (searchTerm.length < 2) {
        return;
    }
    
    try {
        // Show loading
        resultsDiv.innerHTML = '<div class="loading">🔍 Searching...</div>';
        
        console.log('🔍 Starting search for:', searchTerm);
        
        // Search in Supabase
        const result = await window.supabaseSearch.searchProduct(searchTerm);
        
        console.log('📊 Results received:', result);
        
        if (!result.success) {
            resultsDiv.innerHTML = '<div class="no-results">❌ No products found</div>';
            errorDiv.textContent = result.error || 'No products found';
            return;
        }
        // Show results - display ALL products found
        displaySearchResults(result.products);
        
    } catch (error) {
        console.error('Search error:', error);
        errorDiv.textContent = `❌ Search error: ${error.message}`;
        resultsDiv.innerHTML = '';
    }
}

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
        // Get complete product details
        const result = await window.supabaseSearch.searchBySKU(sku);
        
        if (!result.success) {
            document.getElementById('searchError').textContent = result.error || '❌ Product not found';
            return;
        }
        
        selectedProduct = result.product;
        
        // Fill product details
        document.getElementById('foundSku').textContent = result.product.SKU;
        document.getElementById('foundCode').textContent = result.product.Code;
        
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
    
    // Reset data para hoje
    const today = new Date().toISOString().split('T')[0];
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
        if (btn.dataset.size === selectedSize) {
            btn.classList.add('selected');
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
    const qtyFields = ['editQty', 'manualQty'];
    qtyFields.forEach(fieldId => {
        const field = document.getElementById(fieldId);
        if (field) {
            field.addEventListener('input', function(e) {
                // Remove non-numeric characters
                this.value = this.value.replace(/[^0-9]/g, '');
                // Limit to 5 digits
                if (this.value.length > 5) {
                    this.value = this.value.slice(0, 5);
                }
                // Limit to 99999
                if (parseInt(this.value) > 99999) {
                    this.value = 99999;
                }
            });
        }
    });
}

function validateField(fieldId) {
    const field = document.getElementById(fieldId);
    const errorDiv = document.getElementById(fieldId + 'Error');
    
    if (!field) return true;
    
    let isValid = true;
    let errorMessage = '';
    
    if (field.hasAttribute('required') && !field.value.trim()) {
        isValid = false;
        errorMessage = 'This field is required';
    } else if (field.type === 'number' && field.value && parseInt(field.value) < 1) {
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
    }
    
    if (errorDiv) {
        errorDiv.textContent = errorMessage;
        errorDiv.style.display = errorMessage ? 'block' : 'none';
    }
    
    field.classList.toggle('error', !isValid);
    
    return isValid;
}

function validateSearchForm() {
    const qty = document.getElementById('editQty').value;
    
    if (!selectedProduct) {
        return false;
    }
    
    if (!qty || parseInt(qty) < 1) {
        return false;
    }
    
    if (!selectedSearchSize) {
        return false;
    }
    
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
    
    if (!selectedManualSize) {
        isValid = false;
    }
    
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
        code: document.getElementById('manualCode').value,
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
        
        printWindow.onload = function() {
            printWindow.print();
            printWindow.onafterprint = function() {
                printWindow.close();
            };
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
    const { sku, code, qty, date, size, pages } = labelData;
    
    // Format date to DD/MM/YY
    const formattedDate = formatDateForLabel(date);
    
    let pagesHTML = '';
    
    for (let i = 0; i < pages; i++) {
        pagesHTML += `
            <div class="label-page" style="page-break-after: ${i < pages - 1 ? 'always' : 'auto'};">
                <div class="label-content">
                    <div class="sku-line">
                        <span class="sku-label">SKU:</span><span class="sku-spaces"></span><span class="sku-value">${sku}</span>
                    </div>
                    <div class="code-line">
                        <span class="code-label">CODE:</span><span class="code-space"> </span><span class="code-value">${code}</span>
                    </div>
                    <div class="qty-line">
                        <span class="qty-label">QTY:</span><span class="qty-spaces"></span><span class="qty-value">${qty}</span><span class="qty-date-space"></span><span class="date-value">${formattedDate}</span>
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
                    padding: 40mm;
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
                }
                
                .sku-line, .code-line, .qty-line {
                    display: block;
                    margin-bottom: 10mm;
                }
                
                /* A3 specific spacing - more space before QTY line */
                body.a3-mode .qty-line {
                    margin-top: 15mm;
                }
                
                /* A4 Styles */
                body.a4-mode .sku-label,
                body.a4-mode .code-label,
                body.a4-mode .qty-label,
                body.a4-mode .date-value {
                    font-size: 36px;
                }
                
                body.a4-mode .sku-spaces {
                    font-size: 36px;
                    display: inline-block;
                    width: 2em;
                }
                
                body.a4-mode .sku-spaces::after {
                    content: "";
                }
                
                body.a4-mode .sku-value {
                    font-size: 180px;
                }
                
                body.a4-mode .code-value {
                    font-size: 90px;
                    max-width: 20ch;
                    word-break: break-word;
                }
                
                body.a4-mode .qty-spaces {
                    display: inline-block;
                    width: 2em;
                    font-size: 36px;
                }
                
                body.a4-mode .qty-spaces::after {
                    content: "";
                }
                
                body.a4-mode .qty-value {
                    font-size: 160px;
                }
                
                body.a4-mode .qty-date-space::after {
                    content: "    "; /* 2 spaces */
                    font-size: 160px;
                }
                
                /* A3 Styles */
                body.a3-mode .sku-label,
                body.a3-mode .code-label,
                body.a3-mode .qty-label,
                body.a3-mode .date-value {
                    font-size: 75px;
                }
                
                body.a3-mode .sku-spaces {
                    display: inline-block;
                    width: 2em;
                    font-size: 75px;
                }
                
                body.a3-mode .sku-spaces::after {
                    content: "";
                }
                
                body.a3-mode .sku-value {
                    font-size: 200px;
                }
                
                body.a3-mode .code-value {
                    font-size: 150px;
                    max-width: 25ch;
                    word-break: break-word;
                }
                
                body.a3-mode .qty-spaces {
                    display: inline-block;
                    width: 2em;
                    font-size: 75px;
                }
                
                body.a3-mode .qty-spaces::after {
                    content: "";
                }
                
                body.a3-mode .qty-value {
                    font-size: 200px;
                }
                
                body.a3-mode .qty-date-space::after {
                    content: "       "; /* 3 spaces */
                    font-size: 200px;
                }
                
                @media print {
                    body { margin: 0; padding: 40mm; }
                    .label-page { 
                        margin: 0 !important;
                        page-break-inside: avoid;
                    }
                }
            </style>
        </head>
        <body class="${size.toLowerCase()}-mode">
            ${pagesHTML}
        </body>
        </html>
    `;
}

function formatDateForLabel(dateStr) {
    if (!dateStr) {
        const today = new Date();
        return today.toLocaleDateString('en-GB', {
            day: '2-digit',
            month: '2-digit',
            year: '2-digit'
        });
    }
    
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit', 
        year: '2-digit'
    });
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
