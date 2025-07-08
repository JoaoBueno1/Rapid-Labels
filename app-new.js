// Variáveis globais
let selectedSearchSize = null;
let selectedManualSize = null;
let searchPages = 1;
let manualPages = 1;
let selectedProduct = null;

// Inicialização quando a página carrega
document.addEventListener('DOMContentLoaded', function() {
    // Set data atual como padrão
    const today = new Date().toISOString().split('T')[0];
    const editDateInput = document.getElementById('editDate');
    const manualDateInput = document.getElementById('manualDate');
    
    if (editDateInput) editDateInput.value = today;
    if (manualDateInput) manualDateInput.value = today;
    
    // Event listeners para formulário manual
    const manualForm = document.getElementById('manualForm');
    if (manualForm) {
        manualForm.addEventListener('submit', handleManualSubmit);
    }
    
    // Event listener para busca em tempo real
    const searchInput = document.getElementById('productSearch');
    if (searchInput) {
        searchInput.addEventListener('input', debounce(performSearch, 300));
        searchInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                searchProduct();
            }
        });
    }
    
    // Event listeners para validação em tempo real
    setupValidation();
});

// Função debounce para limitar chamadas de API
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

// Busca em tempo real conforme digita
async function performSearch() {
    const searchTerm = document.getElementById('productSearch').value.trim();
    const resultsDiv = document.getElementById('searchResults');
    const errorDiv = document.getElementById('searchError');
    
    // Limpa resultados anteriores
    resultsDiv.innerHTML = '';
    errorDiv.textContent = '';
    
    if (searchTerm.length < 2) {
        return;
    }
    
    try {
        // Mostra loading
        resultsDiv.innerHTML = '<div class="loading">🔍 Searching...</div>';
        
        // Busca no Supabase
        const results = await window.supabaseSearch.searchProducts(searchTerm);
        
        if (results.length === 0) {
            resultsDiv.innerHTML = '<div class="no-results">❌ No products found</div>';
            return;
        }
        
        // Mostra resultados
        displaySearchResults(results);
        
    } catch (error) {
        console.error('Search error:', error);
        errorDiv.textContent = '❌ Search error. Please check your connection.';
        resultsDiv.innerHTML = '';
    }
}

// Exibe os resultados da busca
function displaySearchResults(results) {
    const resultsDiv = document.getElementById('searchResults');
    
    let html = '<div class="search-results-list">';
    results.forEach(product => {
        html += `
            <div class="search-result-item" onclick="selectProduct('${product.sku}', '${product.code}')">
                <div class="result-sku">📦 ${product.sku}</div>
                <div class="result-code">🏷️ ${product.code}</div>
            </div>
        `;
    });
    html += '</div>';
    
    resultsDiv.innerHTML = html;
}

// Seleciona um produto dos resultados
async function selectProduct(sku, code) {
    try {
        // Busca detalhes completos do produto
        const product = await window.supabaseSearch.searchBySKU(sku);
        
        if (!product) {
            document.getElementById('searchError').textContent = '❌ Product not found';
            return;
        }
        
        selectedProduct = product;
        
        // Preenche os detalhes do produto
        document.getElementById('foundSku').textContent = product.sku;
        document.getElementById('foundCode').textContent = product.code;
        
        // Preenche QTY padrão se disponível
        if (product.qty) {
            document.getElementById('editQty').value = product.qty;
        }
        
        // Mostra a seção de detalhes
        document.getElementById('productDetails').classList.remove('hidden');
        document.getElementById('searchResults').innerHTML = '';
        
        // Foca no campo QTY
        document.getElementById('editQty').focus();
        
        updatePrintButton('search');
        
    } catch (error) {
        console.error('Error selecting product:', error);
        document.getElementById('searchError').textContent = '❌ Error loading product details';
    }
}

// Busca produto (botão search)
async function searchProduct() {
    await performSearch();
}

// ==================== MODAL MANUAL ====================

function openManualModal() {
    document.getElementById('manualModal').classList.remove('hidden');
    document.getElementById('manualSku').focus();
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
    // Validação em tempo real para campos obrigatórios
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
    
    // Dimensões baseadas no tamanho
    const dimensions = size === 'A3' ? 
        { width: '420mm', height: '297mm' } : 
        { width: '297mm', height: '210mm' };
    
    let pagesHTML = '';
    
    for (let i = 0; i < pages; i++) {
        pagesHTML += `
            <div class="label-page" style="
                width: ${dimensions.width};
                height: ${dimensions.height};
                padding: 20mm;
                margin: 0;
                page-break-after: ${i < pages - 1 ? 'always' : 'auto'};
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
                font-family: Arial, sans-serif;
                border: 2px solid #000;
                box-sizing: border-box;
            ">
                <div style="text-align: center; width: 100%;">
                    <h1 style="font-size: ${size === 'A3' ? '48px' : '36px'}; margin: 20px 0; font-weight: bold;">
                        📦 PRODUCT LABEL
                    </h1>
                    
                    <div style="font-size: ${size === 'A3' ? '32px' : '24px'}; margin: 30px 0; line-height: 1.5;">
                        <div style="margin: 20px 0;">
                            <strong>SKU:</strong> ${sku}
                        </div>
                        <div style="margin: 20px 0;">
                            <strong>CODE:</strong> ${code}
                        </div>
                        <div style="margin: 20px 0;">
                            <strong>QTY:</strong> ${qty}
                        </div>
                        <div style="margin: 20px 0;">
                            <strong>DATE:</strong> ${formatDate(date)}
                        </div>
                    </div>
                    
                    <div style="margin-top: 40px; font-size: ${size === 'A3' ? '20px' : '16px'}; color: #666;">
                        Page ${i + 1} of ${pages} • Size: ${size}
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
                    size: ${size === 'A3' ? 'A3' : 'A4'};
                }
                * {
                    margin: 0;
                    padding: 0;
                    box-sizing: border-box;
                }
                body {
                    margin: 0;
                    padding: 0;
                    font-family: Arial, sans-serif;
                }
                @media print {
                    body { margin: 0; }
                    .label-page { 
                        margin: 0 !important;
                        page-break-inside: avoid;
                    }
                }
            </style>
        </head>
        <body>
            ${pagesHTML}
        </body>
        </html>
    `;
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
    // ESC para fechar modais
    if (e.key === 'Escape') {
        if (!document.getElementById('searchModal').classList.contains('hidden')) {
            closeSearchModal();
        }
        if (!document.getElementById('manualModal').classList.contains('hidden')) {
            closeManualModal();
        }
    }
    
    // Ctrl+P para imprimir (se modal estiver aberto)
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
