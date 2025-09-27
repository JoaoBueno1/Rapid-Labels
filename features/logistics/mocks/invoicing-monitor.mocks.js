// Mock data for Invoicing Monitor
export function getInvoicingKpis(filters){
  return Promise.resolve({
    pctSameDay: 78.5,
    uninvoicedYesterday: 23,
    uninvoicedLastWeek: 156,
    avgTimeDays: 1.8
  });
}

export function getInvoicingCharts(filters){
  return Promise.resolve({
    weeklyPctInvoiced: {
      labels: ['W-1','W-2','W-3','W-4','W-5'],
      d0: [72,76,79,81,78],
      d1: [18,16,15,14,16],
      d3: [10,8,6,5,6]
    },
    uninvoicedByRep: { labels: ['Alice','Bob','Cleo','Dan'], data: [42,33,51,30] }
  });
}

export function getUninvoicedTable(filters, agingBucket, pagination){
  const base = Array.from({length: 120}).map((_,i)=>({
    order: `SO-${2000+i}`,
    customer: ['ACME','Globex','Umbrella','Initech'][i%4],
    orderDate: `2025-09-${(i%28+1).toString().padStart(2,'0')}`,
    daysPending: (i%6),
    rep: ['Alice','Bob','Cleo','Dan'][i%4],
    status: ['Pending','Pending','Pending','Review'][i%4]
  }));
  const filtered = agingBucket && agingBucket!=='All' ? base.filter(r=>{
    if(agingBucket==='D+1') return r.daysPending===1;
    if(agingBucket==='D+2') return r.daysPending===2;
    if(agingBucket==='D+3') return r.daysPending>=3;
  }): base;
  return Promise.resolve({
    total: filtered.length,
    items: filtered.slice(pagination.offset, pagination.offset + pagination.limit)
  });
}
