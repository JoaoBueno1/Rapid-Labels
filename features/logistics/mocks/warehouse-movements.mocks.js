// Mock data for Warehouse Movements
export function getWarehouseKpis(filters){
  return Promise.resolve({
    correctOrdersPct: 94.2,
    ordersWithErrorsPct: 5.8,
    skusOutOfStockLocator: 37,
  });
}

export function getWarehouseCharts(filters){
  // Return datasets ready for Chart.js aligned with production keys
  const labels = ['2025-08-28','2025-08-29','2025-08-30','2025-08-31','2025-09-01'];
  return Promise.resolve({
    dailyErrorsPct: { labels, data: [4.1,5.3,5.8,6.2,5.8] },
    errorsByType: { labels: ['Wrong Locator','Qty Mismatch','Missing Item','Other'], data: [45,30,15,10] },
    topLocationsWithErrors: [
      { label: 'A1-01 / B1-01', count: 12 },
      { label: 'B2-03 / B2-01', count: 9 }
    ],
    topSkusWithErrors: [
      { label: 'SKU-123', count: 7 },
      { label: 'SKU-987', count: 5 }
    ]
  });
}

export function getWarehouseErrorsTable(filters, pagination){
  const rows = Array.from({length: 42}).map((_,i)=>({
    order: `SO-${1000+i}`,
    customer: ['ACME','Globex','Umbrella','Initech'][i%4],
    date: `2025-09-${(i%28+1).toString().padStart(2,'0')}`,
    usedLocation: ['A1-01','B2-03','C1-02'][i%3],
    correctLocator: ['A1-02','B2-01','C1-01'][i%3],
    sku: `SKU-${i%7}`,
    product: `Product ${i%9}`,
  }));
  return Promise.resolve({
    total: rows.length,
    items: rows.slice(pagination.offset, pagination.offset + pagination.limit)
  });
}
