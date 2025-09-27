// Mock data for Deliveries & Couriers
const TYPES = ['Van Brisbane','Van Gold Coast','Endless Summer','Direct Freight','Phoenix','Jet','Aramex','Australia Post'];

export function getDeliveryKpis(filters){
  // Base values; UI may recompute based on charts selection
  return Promise.resolve({ weeklyOrders: 1247, cartons: 3891, pallets: 156, topCourier: 'Jet' });
}

export function getDeliveryCharts(filters){
  // Support Collections exclusive mode
  const periodLabels = ['P-1','P-2','P-3','P-4','P-5'];
  if (filters?.collection) {
    return Promise.resolve({
      byCourier: { labels: ['Collections'], orders: [380], cartons: [920], pallets: [44] },
      weeklyByCourier: { labels: periodLabels, Collections: [8,9,10,9,11] },
      volumePct: { labels: ['Collections'], data: [100] },
      gatewayWeekly: { labels: periodLabels, toGateway: [10,12,11,13,12], toMain: [18,17,19,16,18] }
    });
  }
  // Otherwise return all delivery types
  const orders = [320, 280, 260, 210, 230, 240, 190, 170];
  const cartons = [980, 860, 810, 730, 760, 790, 680, 610];
  const pallets = [48, 40, 36, 28, 30, 32, 26, 22];
  const weeklyByCourier = { labels: periodLabels };
  TYPES.forEach((t, idx)=>{ weeklyByCourier[t] = [8+idx%3, 9+((idx+1)%3), 10+((idx+2)%3), 9+idx%2, 11-idx%2]; });
  const total = orders.reduce((a,b)=>a+b,0);
  const volumePct = { labels: TYPES, data: orders.map(o=> Math.round(o*100/total)) };
  return Promise.resolve({
    byCourier: { labels: TYPES, orders, cartons, pallets },
    weeklyByCourier,
    volumePct,
    gatewayWeekly: { labels: periodLabels, toGateway: [12,18,15,20,17], toMain: [22,25,19,21,24] }
  });
}

export function getCourierDetailsTable(filters, pagination){
  const selected = filters?.collection ? ['Collections'] : (filters?.types?.length ? filters.types : TYPES);
  const typesPool = selected;
  const rows = Array.from({length: 80}).map((_,i)=>({
    date: `2025-09-${(i%28+1).toString().padStart(2,'0')}`,
    orders: 20 + (i%12),
    cartons: 60 + (i%30),
    pallets: 3 + (i%6),
    type: typesPool[i%typesPool.length]
  }));
  return Promise.resolve({ total: rows.length, items: rows.slice(pagination.offset, pagination.offset + pagination.limit) });
}

export function getGatewayTransfersWeekly(filters, pagination){
  const rows = Array.from({length: 12}).map((_,i)=>({
    week: `2025-W${(i+30)}`,
    toGateway: 10 + (i%10),
    toMain: 18 + (i%8),
  }));
  rows.forEach(r=> r.total = r.toGateway + r.toMain);
  return Promise.resolve({ total: rows.length, items: rows.slice(pagination.offset, pagination.offset + pagination.limit) });
}

export function getGatewayTransfersDaily(filters, pagination){
  // Produce 30 days of mock data based on provided from/to if present
  const makeDate = (d)=> `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const today = new Date(2025, 8, 27); // 2025-09-27 as anchor
  const days = 30;
  const rows = Array.from({length: days}).map((_,i)=>{
    const d = new Date(today); d.setDate(d.getDate() - (days-1-i));
    const base = 12 + (i%7);
    const toGateway = base + (i%5);
    const toMain = base + 6 - (i%4);
    return { date: makeDate(d), toGateway, toMain, total: toGateway + toMain };
  });
  return Promise.resolve({ total: rows.length, items: rows.slice(pagination.offset, pagination.offset + pagination.limit) });
}
