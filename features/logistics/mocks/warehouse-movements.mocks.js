// Mock data for Warehouse Movements
export function getWarehouseKpis(filters){
  return Promise.resolve({
    correctOrdersPct: 94.2,
    ordersWithErrorsPct: 5.8,
    skusOutOfStockLocator: 37,
  });
}

export function getWarehouseCharts(filters){
  // Return datasets ready for Chart.js
  const labels = ['W-1','W-2','W-3','W-4','W-5'];
  return Promise.resolve({
    weeklyErrorsPct: { labels, data: [4.1,5.3,5.8,6.2,5.8] },
    errorsByPicker: { labels: ['Ana','Bruno','Carla','Diego'], data: [12,8,16,7] },
    errorsByLocationHeatmap: {
      xLabels: ['Mon','Tue','Wed','Thu','Fri'],
      yLabels: ['A1','A2','B1','B2','C1'],
      values: [
        [2,1,0,0,3],
        [1,0,1,2,1],
        [0,3,2,1,0],
        [2,2,1,3,1],
        [0,1,0,2,2]
      ]
    },
    errorTypeDistribution: { labels: ['Wrong Locator','Qty Mismatch','Missing Item','Other'], data: [45,30,15,10] }
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
