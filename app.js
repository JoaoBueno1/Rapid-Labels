// Base de dados dos produtos (simulando uma API/banco)
const productsDatabase = {
    "72452": {
        sku: "72452",
        code: "R3118-REFLECTOR-AL",
        defaultQty: 89
    },
    "31280": {
        sku: "31280", 
        code: "R6232-BK-TRI",
        defaultQty: 120
    },
    "45789": {
        sku: "45789",
        code: "R4521-SENSOR-WH", 
        defaultQty: 45
    },
    "89123": {
        sku: "89123",
        code: "R7845-CABLE-BK",
        defaultQty: 200
    },
    "12345": {
        sku: "12345",
        code: "R1234-TEST-PRODUCT",
        defaultQty: 50
    }
};

// Variáveis globais
let selectedSearchSize = null;
let selectedManualSize = null;
let searchPages = 1;
let manualPages = 1;

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
    
    // Event listener para Enter no campo de busca
    const searchInput = document.getElementById('productSearch');
    if (searchInput) {
        searchInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                searchProduct();
            }
        });
        
        // Apenas números no campo de busca
        searchInput.addEventListener('input', function(e) {
            e.target.value = e.target.value.replace(/[^0-9]/g, '');
        });
    }
});

// ========== MODAL FUNCTIONS ==========

function openSearchModal() {
    const modal = document.getElementById('searchModal');
    modal.classList.remove('hidden');
    resetSearchForm();
}

function closeSearchModal() {
    const modal = document.getElementById('searchModal');
    modal.classList.add('hidden');
    resetSearchForm();
}

function openManualModal() {
    const modal = document.getElementById('manualModal');
    modal.classList.remove('hidden');
    resetManualForm();
}

function closeManualModal() {
    const modal = document.getElementById('manualModal');
    modal.classList.add('hidden');
    resetManualForm();
}

// ========== SEARCH FUNCTIONS ==========

function resetSearchForm() {
    document.getElementById('productSearch').value = '';
    document.getElementById('searchError').textContent = '';
    document.getElementById('productDetails').classList.add('hidden');
    selectedSearchSize = null;
    searchPages = 1;
    document.getElementById('pagesCount').value = '1';
    updateSearchPrintButton();
    
    // Reset size buttons
    document.querySelectorAll('#searchModal .size-btn').forEach(btn => {
        btn.classList.remove('selected', 'disabled');
    });
}

function searchProduct() {
    const searchValue = document.getElementById('productSearch').value.trim();
    const errorDiv = document.getElementById('searchError');
    
    // Limpar erro anterior
    errorDiv.textContent = '';
    
    // Validação
    if (!searchValue) {
        errorDiv.textContent = 'Enter a product code';
        return;
    }
    
    if (searchValue.length !== 5) {
        errorDiv.textContent = 'Code must be exactly 5 digits';
        return;
    }
    
    // Buscar produto
    const product = productsDatabase[searchValue];
    
    if (!product) {
        errorDiv.textContent = 'Product not found';
        return;
    }
    
    // Exibir produto encontrado
    displayProduct(product);
}

function displayProduct(product) {
    // Preencher dados do produto
    document.getElementById('foundSku').textContent = product.sku;
    document.getElementById('foundCode').textContent = product.code;
    document.getElementById('editQty').value = product.defaultQty;
    
    // Mostrar seção de detalhes
    document.getElementById('productDetails').classList.remove('hidden');
    
    // Reset seleções
    selectedSearchSize = null;
    searchPages = 1;
    document.getElementById('pagesCount').value = '1';
    updateSearchPrintButton();
    
    // Reset size buttons
    document.querySelectorAll('#searchModal .size-btn').forEach(btn => {
        btn.classList.remove('selected', 'disabled');
    });
}

function selectSize(size) {
    selectedSearchSize = size;
    
    // Update visual state
    document.querySelectorAll('#searchModal .size-btn').forEach(btn => {
        btn.classList.remove('selected');
        if (btn.dataset.size !== size) {
            btn.classList.add('disabled');
        } else {
            btn.classList.remove('disabled');
            btn.classList.add('selected');
        }
    });
    
    updateSearchPrintButton();
}

function increasePages() {
    searchPages++;
    document.getElementById('pagesCount').value = searchPages;
    updateSearchPrintButton();
}

function decreasePages() {
    if (searchPages > 1) {
        searchPages--;
        document.getElementById('pagesCount').value = searchPages;
        updateSearchPrintButton();
    }
}

function updateSearchPrintButton() {
    const printBtn = document.getElementById('printSearchBtn');
    const hasSize = selectedSearchSize !== null;
    const hasPages = searchPages >= 1;
    
    if (hasSize && hasPages) {
        printBtn.classList.remove('disabled');
    } else {
        printBtn.classList.add('disabled');
    }
}

function printSearchLabel() {
    if (!selectedSearchSize || searchPages < 1) {
        return;
    }
    
    const productData = {
        sku: document.getElementById('foundSku').textContent,
        code: document.getElementById('foundCode').textContent,
        qty: document.getElementById('editQty').value,
        date: formatDate(document.getElementById('editDate').value),
        size: selectedSearchSize,
        pages: searchPages
    };
    
    generateAndPrintLabel(productData);
}

// ========== MANUAL FUNCTIONS ==========

function resetManualForm() {
    document.getElementById('manualForm').reset();
    
    // Set data atual
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('manualDate').value = today;
    
    // Clear errors
    document.querySelectorAll('.error').forEach(error => {
        error.textContent = '';
    });
    
    // Reset selections
    selectedManualSize = null;
    manualPages = 1;
    document.getElementById('manualPagesCount').value = '1';
    updateManualPrintButton();
    
    // Reset size buttons
    document.querySelectorAll('#manualModal .size-btn').forEach(btn => {
        btn.classList.remove('selected', 'disabled');
    });
}

function selectManualSize(size) {
    selectedManualSize = size;
    
    // Update visual state
    document.querySelectorAll('#manualModal .size-btn').forEach(btn => {
        btn.classList.remove('selected');
        if (btn.dataset.size !== size) {
            btn.classList.add('disabled');
        } else {
            btn.classList.remove('disabled');
            btn.classList.add('selected');
        }
    });
    
    updateManualPrintButton();
}

function increaseManualPages() {
    manualPages++;
    document.getElementById('manualPagesCount').value = manualPages;
    updateManualPrintButton();
}

function decreaseManualPages() {
    if (manualPages > 1) {
        manualPages--;
        document.getElementById('manualPagesCount').value = manualPages;
        updateManualPrintButton();
    }
}

function updateManualPrintButton() {
    const printBtn = document.getElementById('printManualBtn');
    const hasSize = selectedManualSize !== null;
    const hasPages = manualPages >= 1;
    
    if (hasSize && hasPages) {
        printBtn.classList.remove('disabled');
    } else {
        printBtn.classList.add('disabled');
    }
}

function validateManualForm() {
    let isValid = true;
    
    // Clear previous errors
    document.querySelectorAll('.error').forEach(error => {
        error.textContent = '';
    });
    
    // Validate SKU
    const sku = document.getElementById('manualSku').value.trim();
    if (!sku) {
        document.getElementById('manualSkuError').textContent = 'SKU is required';
        isValid = false;
    }
    
    // Validate Code
    const code = document.getElementById('manualCode').value.trim();
    if (!code) {
        document.getElementById('manualCodeError').textContent = 'Code is required';
        isValid = false;
    }
    
    // Validate Qty
    const qty = document.getElementById('manualQty').value;
    if (!qty || qty < 1) {
        document.getElementById('manualQtyError').textContent = 'Qty must be greater than 0';
        isValid = false;
    }
    
    return isValid;
}

function handleManualSubmit(e) {
    e.preventDefault();
    
    if (!validateManualForm()) {
        return;
    }
    
    if (!selectedManualSize || manualPages < 1) {
        alert('Select size and number of pages');
        return;
    }
    
    const productData = {
        sku: document.getElementById('manualSku').value.trim(),
        code: document.getElementById('manualCode').value.trim(),
        qty: document.getElementById('manualQty').value,
        date: formatDate(document.getElementById('manualDate').value),
        size: selectedManualSize,
        pages: manualPages
    };
    
    generateAndPrintLabel(productData);
}

// ========== PRINT FUNCTIONS ==========

function formatDate(dateString) {
    if (!dateString) {
        const today = new Date();
        return today.toLocaleDateString('pt-BR');
    }
    
    const date = new Date(dateString);
    return date.toLocaleDateString('pt-BR');
}

function generateAndPrintLabel(data) {
    // Gerar múltiplas páginas se necessário
    for (let i = 0; i < data.pages; i++) {
        setTimeout(() => {
            createPrintWindow(data, i + 1);
        }, i * 500); // Delay para evitar conflitos
    }
}

function createPrintWindow(data, pageNumber) {
    const width = data.size === 'A4' ? '210mm' : '297mm';
    const height = data.size === 'A4' ? '297mm' : '420mm';
    
    const labelHTML = `
        <!DOCTYPE html>
        <html lang="pt-BR">
        <head>
            <meta charset="UTF-8">
            <title>Label ${data.size} - Page ${pageNumber}</title>
            <style>
                @page {
                    size: ${data.size};
                    margin: 0;
                }
                
                body {
                    width: ${width};
                    height: ${height};
                    padding: 40mm;
                    box-sizing: border-box;
                    font-family: Arial, sans-serif;
                    margin: 0;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                
                .label {
                    font-size: 24pt;
                    line-height: 2.5;
                    text-align: left;
                }
                
                .label-line {
                    margin-bottom: 20px;
                }
                
                .bold {
                    font-weight: bold;
                }
                
                .page-info {
                    position: absolute;
                    top: 10mm;
                    right: 10mm;
                    font-size: 12pt;
                    color: #666;
                }
            </style>
        </head>
        <body>
            ${data.pages > 1 ? `<div class="page-info">Page ${pageNumber} of ${data.pages}</div>` : ''}
            <div class="label">
                <div class="label-line">
                    <span class="bold">SKU:</span> ${data.sku}
                </div>
                <div class="label-line">
                    <span class="bold">CODE:</span> ${data.code}
                </div>
                <div class="label-line">
                    <span class="bold">QTY:</span> ${data.qty} &nbsp;&nbsp;&nbsp; ${data.date}
                </div>
            </div>
        </body>
        </html>
    `;
    
    const printWindow = window.open('', `print_${pageNumber}`, 'width=800,height=600');
    printWindow.document.write(labelHTML);
    printWindow.document.close();
    printWindow.focus();
    
    // Auto print after a short delay
    setTimeout(() => {
        printWindow.print();
        // Close window after printing
        setTimeout(() => {
            printWindow.close();
        }, 1000);
    }, 500);
}

// ========== UTILITY FUNCTIONS ==========

// Fechar modal ao clicar fora
window.addEventListener('click', function(event) {
    const searchModal = document.getElementById('searchModal');
    const manualModal = document.getElementById('manualModal');
    
    if (event.target === searchModal) {
        closeSearchModal();
    }
    
    if (event.target === manualModal) {
        closeManualModal();
    }
});

// Fechar modal com ESC
window.addEventListener('keydown', function(event) {
    if (event.key === 'Escape') {
        closeSearchModal();
        closeManualModal();
    }
});
