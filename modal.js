// Today's container labels data
const todaysLabels = [
    {
        id: 1,
        sku: "72452",
        code: "R3118-REFLECTOR-AL",
        qty: 89,
        date: "08/07/25",
        size: "A4"
    },
    {
        id: 2,
        sku: "31280",
        code: "R6232-BK-TRI",
        qty: 120,
        date: "08/07/25",
        size: "A3"
    },
    {
        id: 3,
        sku: "45789",
        code: "R4521-SENSOR-WH",
        qty: 45,
        date: "08/07/25",
        size: "A4"
    },
    {
        id: 4,
        sku: "89123",
        code: "R7845-CABLE-BK",
        qty: 200,
        date: "08/07/25",
        size: "A3"
    }
];

let selectedSize = 'A4';

// Initialize when page loads
document.addEventListener('DOMContentLoaded', function() {
    // Set today's date as default
    const dateInput = document.getElementById('date');
    if (dateInput) {
        dateInput.valueAsDate = new Date();
    }
    
    // Initialize size selector
    initializeSizeSelector();
    
    // Initialize manual form
    initializeManualForm();
});

function openTodaysModal() {
    document.getElementById('modal').classList.remove('hidden');
    populateLabelsList();
}

function openManualModal() {
    document.getElementById('manualModal').classList.remove('hidden');
    // Reset form
    document.getElementById('manualLabelForm').reset();
    document.getElementById('date').valueAsDate = new Date();
    selectedSize = 'A4';
    updateSizeSelection();
    clearErrors();
}

function closeModal() {
    document.getElementById('modal').classList.add('hidden');
}

function closeManualModal() {
    document.getElementById('manualModal').classList.add('hidden');
}

function initializeSizeSelector() {
    const sizeOptions = document.querySelectorAll('.size-option');
    sizeOptions.forEach(option => {
        option.addEventListener('click', function() {
            sizeOptions.forEach(o => o.classList.remove('selected'));
            this.classList.add('selected');
            selectedSize = this.dataset.size;
        });
    });
}

function updateSizeSelection() {
    document.querySelectorAll('.size-option').forEach(option => {
        option.classList.remove('selected');
        if (option.dataset.size === selectedSize) {
            option.classList.add('selected');
        }
    });
}

function initializeManualForm() {
    const form = document.getElementById("manualLabelForm");
    if (form) {
        form.addEventListener("submit", function(e) {
            e.preventDefault();
            
            if (validateForm()) {
                const formData = getFormData();
                generateManualLabel(formData, false);
                showManualSuccess();
            }
        });
    }
}

function populateLabelsList() {
    const labelsList = document.getElementById('labelsList');
    labelsList.innerHTML = '';
    
    todaysLabels.forEach(label => {
        const labelItem = document.createElement('div');
        labelItem.className = 'label-item';
        labelItem.innerHTML = `
            <div class="label-info">
                <div class="label-header">
                    <span class="sku">SKU: ${label.sku}</span>
                    <span class="size-badge ${label.size.toLowerCase()}">${label.size}</span>
                </div>
                <div class="label-code">CODE: ${label.code}</div>
                <div class="label-qty">QTY: ${label.qty} - ${label.date}</div>
            </div>
            <div class="label-actions">
                <button onclick="previewLabel(${label.id})" class="preview-btn">👁 Preview</button>
                <button onclick="printLabel(${label.id})" class="print-btn">🖨 Print</button>
            </div>
        `;
        labelsList.appendChild(labelItem);
    });
}

function previewLabel(labelId) {
    const label = todaysLabels.find(l => l.id === labelId);
    if (label) {
        generateLabelPreview(label);
    }
}

function printLabel(labelId) {
    const label = todaysLabels.find(l => l.id === labelId);
    if (label) {
        generateLabelForPrint(label);
    }
}

function generateLabelPreview(label) {
    const previewWindow = window.open('', 'preview', 'width=600,height=400');
    const labelHTML = generateLabelHTML(label, true);
    previewWindow.document.write(labelHTML);
    previewWindow.document.close();
}

function generateLabelForPrint(label) {
    const printWindow = window.open('', 'print', 'width=800,height=600');
    const labelHTML = generateLabelHTML(label, false);
    printWindow.document.write(labelHTML);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => {
        printWindow.print();
    }, 500);
}

function generateLabelHTML(label, isPreview) {
    const width = label.size === 'A4' ? '210mm' : '297mm';
    const height = label.size === 'A4' ? '297mm' : '420mm';
    const fontSize = isPreview ? '16pt' : '24pt';
    const previewStyle = isPreview ? 'transform: scale(0.5); transform-origin: top left;' : '';
    
    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <title>Label ${label.size} ${isPreview ? '- Preview' : ''}</title>
            <style>
                body {
                    width: ${width};
                    height: ${height};
                    padding: 40mm;
                    box-sizing: border-box;
                    font-family: Arial, sans-serif;
                    margin: 0;
                    ${previewStyle}
                }
                .label {
                    font-size: ${fontSize};
                    line-height: 2;
                }
                .bold {
                    font-weight: bold;
                }
                ${isPreview ? '.preview-header { background: #e3f2fd; padding: 10px; margin-bottom: 20px; text-align: center; font-size: 14pt; color: #1976d2; }' : ''}
            </style>
        </head>
        <body>
            ${isPreview ? '<div class="preview-header">🔍 PREVIEW - Close this window to return</div>' : ''}
            <div class="label">
                <div><span class="bold">SKU:</span> ${label.sku}</div>
                <div><span class="bold">CODE:</span> ${label.code}</div>
                <div><span class="bold">QTY:</span> ${label.qty} &nbsp;&nbsp;&nbsp; ${label.date}</div>
            </div>
        </body>
        </html>
    `;
}

// Manual label functions
function validateForm() {
    let isValid = true;
    
    // Clear previous errors
    clearErrors();
    
    const sku = document.getElementById('sku').value.trim();
    const code = document.getElementById('code').value.trim();
    const qty = document.getElementById('qty').value;
    
    if (!sku) {
        document.getElementById('skuError').textContent = 'SKU is required';
        isValid = false;
    }
    
    if (!code) {
        document.getElementById('codeError').textContent = 'CODE is required';
        isValid = false;
    }
    
    if (!qty || qty < 1) {
        document.getElementById('qtyError').textContent = 'QTY must be at least 1';
        isValid = false;
    }
    
    return isValid;
}

function clearErrors() {
    document.querySelectorAll('.error').forEach(error => error.textContent = '');
}

function getFormData() {
    const dateInput = document.getElementById('date').value;
    const formattedDate = dateInput ? new Date(dateInput).toLocaleDateString('en-GB') : new Date().toLocaleDateString('en-GB');
    
    return {
        sku: document.getElementById('sku').value.trim(),
        code: document.getElementById('code').value.trim(),
        qty: document.getElementById('qty').value,
        date: formattedDate,
        size: selectedSize
    };
}

function previewManualLabel() {
    if (validateForm()) {
        const formData = getFormData();
        generateManualLabel(formData, true);
    }
}

function generateManualLabel(data, isPreview) {
    const width = data.size === 'A4' ? '210mm' : '297mm';
    const height = data.size === 'A4' ? '297mm' : '420mm';
    const fontSize = isPreview ? '16pt' : '24pt';
    const previewStyle = isPreview ? 'transform: scale(0.5); transform-origin: top left;' : '';
    
    const labelHTML = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <title>Manual Label ${data.size} ${isPreview ? '- Preview' : ''}</title>
            <style>
                body {
                    width: ${width};
                    height: ${height};
                    padding: 40mm;
                    box-sizing: border-box;
                    font-family: Arial, sans-serif;
                    margin: 0;
                    ${previewStyle}
                }
                .label {
                    font-size: ${fontSize};
                    line-height: 2;
                }
                .bold {
                    font-weight: bold;
                }
                ${isPreview ? '.preview-header { background: #e3f2fd; padding: 10px; margin-bottom: 20px; text-align: center; font-size: 14pt; color: #1976d2; }' : ''}
            </style>
        </head>
        <body>
            ${isPreview ? '<div class="preview-header">🔍 PREVIEW - Close this window to return</div>' : ''}
            <div class="label">
                <div><span class="bold">SKU:</span> ${data.sku}</div>
                <div><span class="bold">CODE:</span> ${data.code}</div>
                <div><span class="bold">QTY:</span> ${data.qty} &nbsp;&nbsp;&nbsp; ${data.date}</div>
            </div>
        </body>
        </html>
    `;
    
    const windowName = isPreview ? 'preview' : 'print';
    const windowFeatures = isPreview ? 'width=600,height=400' : 'width=800,height=600';
    const labelWindow = window.open('', windowName, windowFeatures);
    
    labelWindow.document.write(labelHTML);
    labelWindow.document.close();
    labelWindow.focus();
    
    if (!isPreview) {
        setTimeout(() => {
            labelWindow.print();
        }, 500);
    }
}

function showManualSuccess() {
    const successMessage = document.getElementById('manualSuccessMessage');
    successMessage.style.display = 'block';
    setTimeout(() => {
        successMessage.style.display = 'none';
    }, 3000);
}