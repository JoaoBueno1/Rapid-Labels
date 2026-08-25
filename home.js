/* home.js — the home dashboard: data loaders, modals, the pipeline board and its chart.
 *
 * Split out of index.html. Loaded as a classic script in the same position the inline
 * block occupied (last, after app.js and Chart.js), so execution order and the DOM it
 * expects are exactly what they were. Not a module, on purpose: the markup calls these
 * functions from onclick attributes, which need them global.
 */
        // Service worker disabled for production stability
        
        // Hash routing handled by app.js (DOMContentLoaded + hashchange)

        // ══════════════════════════════════════════════════════
        // DASHBOARD DATA LOADER
        // ══════════════════════════════════════════════════════
        (async () => {
            try {
                await window.supabaseReady;
                const sb = window.supabase;
                if (!sb) return;

                const pad = n => String(n).padStart(2, '0');
                // AEST (UTC+10) helper — warehouse is in Brisbane (no DST)
                const AEST_OFFSET = 10;
                const aestNow = () => new Date(Date.now() + AEST_OFFSET * 3600000);
                const aestToday = () => aestNow().toISOString().split('T')[0];
                const aestDayStart = (d) => d + 'T00:00:00+10:00';
                const aestDayEnd = (d) => d + 'T23:59:59+10:00';
                const fmtAgo = (ts) => {
                    if (!ts) return { str: 'N/A', min: 999 };
                    const agoMs = Date.now() - ts.getTime();
                    const agoMin = Math.floor(agoMs / 60000);
                    const str = agoMin < 1 ? 'just now' : agoMin < 60 ? `${agoMin}m ago` : `${Math.floor(agoMin/60)}h${agoMin%60 > 0 ? ' '+agoMin%60+'m' : ''} ago`;
                    return { str, min: agoMin };
                };
                const setKpi = (id, val, sub) => {
                    const el = document.getElementById(id + 'Val');
                    if (el) { el.textContent = val; el.classList.remove('loading'); }
                    if (sub) { const s = document.getElementById(id + 'Sub'); if (s) s.textContent = sub; }
                };
                const setHealth = (id, color, detail) => {
                    const dot = document.getElementById(id + 'Dot');
                    const det = document.getElementById(id + 'Detail');
                    if (dot) { dot.className = 'health-dot ' + color; }
                    if (det) det.textContent = detail;
                };

                const activities = [];
                const addActivity = (icon, text, time) => activities.push({ icon, text, time });

                // ─── 1. Collections Count (pending) ───
                try {
                    const { count, error } = await sb
                        .from('collections_active')
                        .select('id', { count: 'exact', head: true });
                    if (!error && typeof count === 'number') {
                        setKpi('kpiColl', count, count === 0 ? 'none pending' : 'awaiting pickup');
                        const badge = document.getElementById('collectionsCount');
                        if (badge) { badge.textContent = count; badge.style.display = ''; if (count === 0) badge.classList.add('zero'); }
                        if (count > 0) addActivity('📦', `${count} collection${count>1?'s':''} awaiting pickup`, '');
                    }
                } catch(e) {}

                // ─── 1b. Returns active (pending / in treatment) ───
                try {
                    const { count, error } = await sb
                        .from('returns_active')
                        .select('id', { count: 'exact', head: true })
                        .neq('status', 'completed');
                    if (!error && typeof count === 'number') {
                        const badge = document.getElementById('returnsCount');
                        if (badge) { badge.textContent = count; badge.style.display = ''; if (count === 0) badge.classList.add('zero'); }
                        if (count > 0) addActivity('↩️', `${count} return${count>1?'s':''} awaiting action`, '');
                    }
                } catch(e) {}

                // ─── 2. Collections completed today ───
                let collToday = 0;
                try {
                    const todayAest = aestToday();
                    const { count, error } = await sb
                        .from('collections_history')
                        .select('id', { count: 'exact', head: true })
                        .gte('collected_at', aestDayStart(todayAest))
                        .lte('collected_at', aestDayEnd(todayAest));
                    if (!error && typeof count === 'number') {
                        collToday = count;
                        if (collToday > 0) addActivity('✅', `${collToday} collection${collToday>1?'s':''} completed today`, '');
                    }
                } catch(e) {}

                // ─── 3. Stock Sync (cin7_mirror.sync_runs) ───
                try {
                    const { data, error } = await sb
                        .schema('cin7_mirror')
                        .from('sync_runs')
                        .select('ended_at, status, duration_ms, products_synced, stock_rows_synced')
                        .order('ended_at', { ascending: false })
                        .limit(1);
                    if (!error && data && data.length) {
                        const run = data[0];
                        const ok = run.status === 'success';
                        const ts = run.ended_at ? new Date(run.ended_at) : null;
                        const ago = fmtAgo(ts);
                        const color = !ok ? 'red' : ago.min > 90 ? 'red' : ago.min > 75 ? 'yellow' : 'green';
                        setHealth('healthStock', color, `${ago.str}${run.products_synced ? ' · ' + run.products_synced + ' products' : ''}`);
                        // Sync badges for buttons
                        if (ts) {
                            const timeStr = `${pad(ts.getDate())}/${pad(ts.getMonth()+1)} ${pad(ts.getHours())}:${pad(ts.getMinutes())}`;
                            const dotColor = ok ? '#22c55e' : '#ef4444';
                            const agoColor = ago.min > 180 ? '#ef4444' : ago.min > 130 ? '#f59e0b' : '#64748b';
                            const html = `<span class="sync-dot" style="background:${dotColor}"></span>Last sync: ${timeStr} · <span style="color:${agoColor}">${ago.str}</span>`;
                            const plain = `Last sync: ${timeStr} · ${ago.str}`;
                            ['syncBadgeRestock', 'syncBadgeGateway'].forEach(id => {
                                const el = document.getElementById(id);
                                if (el) { el.innerHTML = html; el.title = plain; el.style.display = ''; }
                            });
                        }
                    }
                } catch(e) { setHealth('healthStock', 'gray', 'unavailable'); }

                // ─── 4. Total SKUs in Main Warehouse ───
                try {
                    const { count, error } = await sb
                        .schema('cin7_mirror')
                        .from('stock_snapshot')
                        .select('id', { count: 'exact', head: true })
                        .eq('location_name', 'Main Warehouse')
                        .gt('available', 0);
                    if (!error && typeof count === 'number') {
                        setKpi('kpiSkus', count.toLocaleString(), 'in Main Warehouse');
                    }
                } catch(e) { setKpi('kpiSkus', '—', 'unavailable'); }

                // ─── 5. Low Stock items (available <= minimum_before_reorder) ───
                try {
                    // Get products with minimum_before_reorder > 0 AND available <= minimum_before_reorder
                    const { data: products, error: pErr } = await sb
                        .schema('cin7_mirror')
                        .from('products')
                        .select('sku, minimum_before_reorder')
                        .gt('minimum_before_reorder', 0);
                    if (!pErr && products && products.length) {
                        // Get stock for those SKUs
                        const skus = products.map(p => p.sku);
                        const minMap = {};
                        products.forEach(p => { minMap[p.sku] = p.minimum_before_reorder; });
                        const { data: stock, error: sErr } = await sb
                            .schema('cin7_mirror')
                            .from('stock_snapshot')
                            .select('sku, available')
                            .eq('location_name', 'Main Warehouse')
                            .in('sku', skus);
                        if (!sErr && stock) {
                            let lowCount = 0;
                            stock.forEach(s => {
                                if (s.available <= (minMap[s.sku] || 0)) lowCount++;
                            });
                            setKpi('kpiLow', lowCount, lowCount === 0 ? 'all healthy' : 'items below min');
                            if (lowCount > 0) addActivity('⚠️', `${lowCount} SKU${lowCount>1?'s':''} below minimum stock level`, '');
                        }
                    } else {
                        // Fallback: count items with available = 0
                        const { count, error } = await sb
                            .schema('cin7_mirror')
                            .from('stock_snapshot')
                            .select('id', { count: 'exact', head: true })
                            .eq('location_name', 'Main Warehouse')
                            .lte('available', 0);
                        if (!error) setKpi('kpiLow', count || 0, 'out of stock');
                    }
                } catch(e) { setKpi('kpiLow', '—', 'unavailable'); }

                // ─── 6. Pick Anomalies Stats ───
                try {
                    const { data, error } = await sb
                        .from('pick_anomaly_sync')
                        .select('last_synced_at, total_orders, last_new_orders')
                        .eq('id', 1)
                        .limit(1);
                    if (!error && data && data.length) {
                        const meta = data[0];
                        const ts = meta.last_synced_at ? new Date(meta.last_synced_at) : null;
                        const ago = fmtAgo(ts);
                        const color = ago.min > 180 ? 'red' : ago.min > 130 ? 'yellow' : 'green';
                        setHealth('healthPick', color, `${ago.str} · ${meta.total_orders || 0} orders`);
                        // Sync badge for PA button
                        if (ts) {
                            const timeStr = `${pad(ts.getDate())}/${pad(ts.getMonth()+1)} ${pad(ts.getHours())}:${pad(ts.getMinutes())}`;
                            const agoColor = ago.min > 180 ? '#ef4444' : ago.min > 130 ? '#f59e0b' : '#64748b';
                            const html = `<span class="sync-dot" style="background:#22c55e"></span>Last sync: ${timeStr} · <span style="color:${agoColor}">${ago.str}</span> · ${meta.total_orders||0} orders`;
                            const el = document.getElementById('syncBadgePA');
                            if (el) { el.innerHTML = html; el.title = `Last sync: ${timeStr} · ${ago.str} · ${meta.total_orders||0} orders`; el.style.display = ''; }
                        }
                    }

                    // Get accuracy stats (via server endpoint — paginates past Supabase 1000-row limit)
                    try {
                        const statsRes = await fetch('/api/pick-anomalies/stats');
                        const statsJson = await statsRes.json();
                        if (statsJson.success && statsJson.stats) {
                            const s = statsJson.stats;
                            const accuracy = s.picks > 0 ? ((s.correct / s.picks) * 100).toFixed(1) : 0;
                            setKpi('kpiAccuracy', accuracy + '%', `${s.orders} orders · ${s.anomalyOrders} with issues`);
                            if (s.anomalyOrders > 0) addActivity('📋', `${s.anomalyOrders} order${s.anomalyOrders>1?'s':''} with pick anomalies detected`, '');
                        } else {
                            setKpi('kpiAccuracy', '—', 'no data yet');
                        }
                    } catch(statsErr) {
                        console.warn('Stats endpoint unavailable, falling back to Supabase direct');
                        // Fallback: direct Supabase query (may be limited to 1000 rows)
                        const { data: orders, error: oErr } = await sb
                            .from('pick_anomaly_orders')
                            .select('total_picks, correct_picks, anomaly_picks');
                        if (!oErr && orders && orders.length) {
                            let totalPicks = 0, correctPicks = 0, anomalyOrders = 0;
                            orders.forEach(o => {
                                totalPicks += (o.total_picks || 0);
                                correctPicks += (o.correct_picks || 0);
                                if ((o.anomaly_picks || 0) > 0) anomalyOrders++;
                            });
                            const accuracy = totalPicks > 0 ? ((correctPicks / totalPicks) * 100).toFixed(1) : 0;
                            setKpi('kpiAccuracy', accuracy + '%', `${orders.length} orders · ${anomalyOrders} with issues`);
                            if (anomalyOrders > 0) addActivity('📋', `${anomalyOrders} order${anomalyOrders>1?'s':''} with pick anomalies detected`, '');
                        } else {
                            setKpi('kpiAccuracy', '—', 'no data yet');
                        }
                    }
                } catch(e) {
                    setHealth('healthPick', 'gray', 'unavailable');
                    setKpi('kpiAccuracy', '—', 'unavailable');
                }

                // ─── 7. Gateway Stats ───
                // Reads the lot ledger (gateway_v_sku_balance), not the old
                // gateway_allocations seed — that table is a frozen 2026-02-26
                // snapshot whose stock_date column is a day out on every row and
                // in the future on 146 of them, so its ageing was meaningless.
                try {
                    const { data: bal, error: aErr } = await sb
                        .from('gateway_v_sku_balance')
                        .select('sku, qty_on_hand, oldest_age_days, undated_lots');
                    if (!aErr && bal) {
                        const held = bal.filter(b => Number(b.qty_on_hand) > 0);
                        let warn = 0, alert = 0, undated = 0;
                        held.forEach(b => {
                            if (b.oldest_age_days >= 120) alert++;
                            else if (b.oldest_age_days >= 60) warn++;
                            undated += Number(b.undated_lots || 0);
                        });
                        const color = alert > 0 ? 'red' : warn > 0 ? 'yellow' : 'green';
                        setHealth('healthGateway', color,
                            `${held.length} products · ${alert + warn > 0 ? (alert + warn) + ' aging' : 'all fresh'}`);
                        if (alert > 0) addActivity('🏭', `Gateway: ${alert} product${alert>1?'s':''} over 120 days old`, '');
                        if (undated > 0) addActivity('🏭', `Gateway: ${undated} pallet${undated>1?'s':''} with no arrival date`, '');
                    } else {
                        setHealth('healthGateway', 'gray', 'not deployed');
                    }
                } catch(e) { setHealth('healthGateway', 'gray', 'unavailable'); }

                // ─── 8. Replacements Stats ───
                try {
                    const { count: activeCount, error: rErr } = await sb
                        .from('replacements_requests')
                        .select('id', { count: 'exact', head: true })
                        .eq('status', 'ACTIVE');
                    if (!rErr && typeof activeCount === 'number') {
                        const color = activeCount > 3 ? 'red' : activeCount > 0 ? 'yellow' : 'green';
                        setHealth('healthRepl', color, activeCount > 0 ? `${activeCount} active request${activeCount>1?'s':''}` : 'none open');
                        if (activeCount > 0) addActivity('🔄', `${activeCount} replacement request${activeCount>1?'s':''} open`, '');
                    }
                } catch(e) { setHealth('healthRepl', 'gray', 'unavailable'); }

                // ─── 9. Recent Gateway Movements (today) ───
                // occurred_at, not created_at: a move keyed in this morning for
                // yesterday belongs to yesterday.
                try {
                    const gwTodayAest = aestToday();
                    const { count, error } = await sb
                        .from('gateway_movements')
                        .select('id', { count: 'exact', head: true })
                        .gte('occurred_at', aestDayStart(gwTodayAest));
                    if (!error && count > 0) {
                        addActivity('🏭', `${count} Gateway stock movement${count>1?'s':''} today`, '');
                    }
                } catch(e) {}

                // ─── 10. Warehouse Pipeline (cin7_mirror.order_pipeline) — flow board, auto-refresh ───
                async function loadWarehouseBoard() {
                    try {
                        // Paginate past the PostgREST 1000-row cap (was .select('*') unbounded)
                        let pipeline = [], from = 0;
                        for (;;) {
                            const { data, error } = await sb.schema('cin7_mirror')
                                .from('order_pipeline').select('*').range(from, from + 999);
                            if (error) throw error;
                            if (!data || !data.length) break;
                            pipeline.push(...data);
                            if (data.length < 1000) break;
                            from += 1000;
                        }
                        const MAIN_WH = 'Main Warehouse';
                        // Focus warehouse — the board opens on Main; the selector re-scopes it to any
                        // site, or '__all__' for the whole network. Scanner metrics stay Main-only.
                        const focus = window.__whFocus || MAIN_WH;
                        const isAll = focus === '__all__';
                        const onMain = focus === MAIN_WH;
                        const scoped = isAll ? pipeline : pipeline.filter(r => r.from_location === focus);
                        window.__pipelineData = scoped;                 // the orders modal reads the focused scope
                        window.__transferData = pipeline.filter(r => r.type === 'TR');
                        window.__whFocusValue = focus;
                        populateWhSelector(pipeline, focus);            // build the selector once, from the data

                        // ── Flow stages: SALES ORDERS for the focused warehouse, one stage per order ──
                        // Cin7 keeps status='ORDERED' even after pick/pack, so we drive the stages off
                        // pick_status/pack_status (not status) to avoid the same order landing in two
                        // tiles. Transfers (TR) are NOT in the SO flow — they live in the footer.
                        const _completedStatuses = ['COMPLETED','VOIDED','CLOSED','INVOICED'];
                        const soFocus = scoped.filter(r => r.type === 'SO');
                        const openSO  = soFocus.filter(r => !_completedStatuses.includes(r.status));
                        const isPicking = r => r.pick_status === 'PICKING';
                        const isPicked  = r => r.pick_status === 'PICKED';
                        const isPacked  = r => r.pack_status === 'PACKED';
                        // Aging window: only orders from the last N days count as the live queue;
                        // older ones are stuck (backorder/on-hold) — excluded from the headline but
                        // still shown (in red) in the modal so they get actioned.
                        const ACTIVE_WINDOW_DAYS = 5;
                        const ageCutoff = new Date(Date.now() + 10 * 3600000 - ACTIVE_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
                        const recent = r => (r.order_date || '') >= ageCutoff;
                        const orderedRows = openSO.filter(r => r.status === 'ORDERED' && !isPicking(r) && !isPicked(r)); // awaiting pick
                        const pickingRows = openSO.filter(r => isPicking(r));
                        const ordered = orderedRows.filter(recent).length;
                        const picking = pickingRows.filter(recent).length;
                        const orderedAged = orderedRows.length - ordered;
                        const pickingAged = pickingRows.length - picking;
                        const toPack  = openSO.filter(r => isPicked(r) && !isPacked(r)).length;                            // picked, awaiting pack

                        // Completed today — orders SHIPPED from Main today. Source: the LIVE
                        // scanner table pick_anomaly_orders (fulfilled_date = ship date) — the
                        // SAME source the chart uses, so this tile and the chart's today bar
                        // always agree. The old order_pipeline path read 0 while ~100 shipped:
                        // its completed_at was the SYNC time (not the real completion time) AND
                        // its sync lags (last run can be a day old). fulfilled_date is webhook-fed
                        // and fresh within ~1min.
                        // Completed today is SCANNER data (Main only). For any other focus we cannot
                        // honestly count real-time ships, so show a dash instead of a misleading 0.
                        const aestTodayKey = new Date(Date.now() + 10 * 3600000).toISOString().slice(0, 10);
                        let completedToday = 0;
                        if (onMain) {
                            try {
                                const { count } = await sb.from('pick_anomaly_orders')
                                    .select('*', { count: 'exact', head: true })
                                    .eq('entity_type', 'sale').eq('fulfilled_date', aestTodayKey);
                                completedToday = count || 0;
                            } catch (e) { /* leave 0 on error */ }
                        }

                        // Transfers (footer) — relative to the focused warehouse (Main as the hub for "All")
                        const trWh = isAll ? MAIN_WH : focus;
                        const outboundTR = pipeline.filter(r => r.type === 'TR' && r.from_location === trWh);
                        const outOrdered = outboundTR.filter(r => r.status === 'ORDERED').length;
                        const inboundTR = pipeline.filter(r => r.type === 'TR' && r.to_location === trWh && r.from_location !== trWh);
                        const inInTransit = inboundTR.filter(r => r.status === 'IN TRANSIT').length;
                        const inOrdered = inboundTR.filter(r => r.status === 'ORDERED').length;

                        // Paint the flow board
                        setKpi('flowOrdered', ordered, orderedAged ? `awaiting pick · ${orderedAged} aged` : 'awaiting pick');
                        setKpi('flowPicking', picking, pickingAged ? `in progress · ${pickingAged} aged` : 'in progress');
                        setKpi('flowToPack', toPack, 'picked · awaiting pack');
                        setKpi('flowCompleted', onMain ? completedToday : '—', onMain ? 'today · live' : 'Main only (scanner)');
                        setKpi('whTransfers', outOrdered, `${outOrdered} to send`);
                        setKpi('whIncoming', inInTransit + inOrdered, `${inInTransit} in transit · ${inOrdered} ordered`);
                        renderInlineTransfers(trWh);

                        // ── Exceptions (scoped to the focused warehouse) — what needs action now ──
                        // Aging is by order_date (Cin7 has no per-stage timestamp yet — that's Phase 2);
                        // so ">2d" here means the ORDER is 2+ days old and still stuck at that stage.
                        const _age = r => r.order_date ? Math.floor((Date.now() - new Date(r.order_date + 'T00:00:00').getTime()) / 86400000) : 0;
                        const oldest = arr => arr.length ? Math.max.apply(null, arr.map(_age)) : 0;
                        const agedPick    = orderedRows.filter(r => _age(r) > 2);
                        const backorders  = soFocus.filter(r => r.status === 'BACKORDERED');
                        const packStuck   = openSO.filter(r => isPicked(r) && !isPacked(r) && _age(r) > 2);
                        const dispatchStk = soFocus.filter(r => isPacked(r) && !_completedStatuses.includes(r.status) && String(r.ship_status || '').toUpperCase() !== 'SHIPPED');
                        setExc('excAged',      agedPick.length,    agedPick.length ? `oldest ${oldest(agedPick)}d` : 'clear', 'crit');
                        setExc('excBackorder', backorders.length,  backorders.length ? `oldest ${oldest(backorders)}d` : 'clear', 'crit');
                        setExc('excPack',      packStuck.length,   packStuck.length ? 'picked > 2d ago' : 'clear', 'warn');
                        setExc('excDispatch',  dispatchStk.length, dispatchStk.length ? 'packed, not shipped' : 'clear', 'warn');

                        // Sync freshness — prefer the order_pipeline heartbeat (real success/failure),
                        // fall back to the newest row's synced_at until the first heartbeat lands.
                        const syncTimes = pipeline.map(r => r.synced_at).filter(Boolean).sort();
                        const syncEl = document.getElementById('whSyncInfo');
                        if (syncEl) {
                            const fallback = () => {
                                if (!syncTimes.length) return;
                                const ago = fmtAgo(new Date(syncTimes[syncTimes.length - 1]));
                                syncEl.innerHTML = ago.min > 120 ? `<span style="color:#ef4444;font-weight:600">⚠ orders synced ${ago.str}</span>` : `orders synced ${ago.str}`;
                            };
                            try {
                                const { data: hb } = await sb.schema('cin7_mirror').from('sync_runs')
                                    .select('ended_at,status').eq('sync_type', 'order_pipeline')
                                    .order('started_at', { ascending: false }).limit(1);
                                const run = (hb || [])[0];
                                if (run && run.ended_at) {
                                    const ago = fmtAgo(new Date(run.ended_at));
                                    if (run.status !== 'success') syncEl.innerHTML = `<span style="color:#ef4444;font-weight:600">⚠ orders sync failed · ${ago.str}</span>`;
                                    else if (ago.min > 130) syncEl.innerHTML = `<span style="color:#ef4444;font-weight:600">⚠ orders synced ${ago.str}</span>`;
                                    else syncEl.innerHTML = `orders synced ${ago.str}`;
                                } else fallback();
                            } catch (e) { fallback(); }
                        }
                    } catch (e) {
                        console.warn('Pipeline board error:', e);
                        const syncEl = document.getElementById('whSyncInfo');
                        if (syncEl) syncEl.textContent = 'sync error';
                    }

                    // Hero — Pick Accuracy (Main scanner only; skip the fetch for other focuses)
                    if ((window.__whFocus || 'Main Warehouse') === 'Main Warehouse') {
                        try {
                            const r = await fetch('/api/pick-anomalies/stats');
                            const j = await r.json();
                            if (j.success && j.stats && j.stats.picks > 0) {
                                const s = j.stats;
                                setKpi('kpiAccuracy', ((s.correct / s.picks) * 100).toFixed(1) + '%', `${s.orders} orders · ${s.anomalyOrders} with issues`);
                            }
                        } catch (e) {}
                    }
                }
                window.reloadWhBoard = loadWarehouseBoard;   // warehouse selector → re-scope + repaint
                await loadWarehouseBoard();
                // Auto-refresh the board every 60s (wall display, no manual refresh button)
                if (!window.__whBoardTimer) window.__whBoardTimer = setInterval(loadWarehouseBoard, 60000);

                // Weekly trend chart (refresh every 5 min — it moves slowly)
                loadPipelineChart();
                if (!window.__whChartTimer) window.__whChartTimer = setInterval(loadPipelineChart, 300000);

            } catch(e) { console.warn('Dashboard load error:', e); }
        })();

        // ══════════════════════════════════════════════════════
        // PIPELINE FULLSCREEN (wall display / TV)
        // ══════════════════════════════════════════════════════
        function togglePipelineFullscreen() {
            const card = document.getElementById('whPipelineCard');
            if (!card) return;
            const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
            if (!fsEl) {
                (card.requestFullscreen || card.webkitRequestFullscreen || function(){}).call(card);
            } else {
                (document.exitFullscreen || document.webkitExitFullscreen || function(){}).call(document);
            }
        }
        // Modals live outside #whPipelineCard, so under requestFullscreen(card) they render
        // behind it — dead clicks on the wall. While in fullscreen, move the open overlay into
        // the fullscreen element; restore it home on close or when fullscreen exits.
        function _mountModalInFs(id) {
            const fs = document.fullscreenElement || document.webkitFullscreenElement;
            const ov = document.getElementById(id);
            if (fs && ov && ov.parentElement !== fs) { ov.__home = ov.parentElement; fs.appendChild(ov); }
        }
        function _restoreModal(id) {
            const ov = document.getElementById(id);
            if (ov && ov.__home && ov.parentElement !== ov.__home) { ov.__home.appendChild(ov); ov.__home = null; }
        }
        function _onFsChange() {
            const card = document.getElementById('whPipelineCard');
            const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
            const on = !!card && fsEl === card;
            if (card) card.classList.toggle('pipeline-fs', on);
            if (!on) { _restoreModal('ordersModalOverlay'); _restoreModal('trModalOverlay'); _restoreModal('trLinesOverlay'); }
            _paintChart(on);
        }
        // The chart draws on a canvas, so CSS cannot reach its axis labels, legend or
        // gridlines — they stay Chart.js's near-black and vanish against the wall
        // display's navy. Repaint them with the mode.
        function _paintChart(dark) {
            const c = window.__pipelineChart;
            if (!c || !c.options) return;
            const text = dark ? '#cbd5e1' : '#666666';
            const grid = dark ? 'rgba(148,163,184,.18)' : '#eef2f7';
            try {
                c.options.plugins.legend.labels.color = text;
                c.options.scales.x.ticks.color = text;
                c.options.scales.y.ticks.color = text;
                c.options.scales.y.grid.color = grid;
                c.options.scales.y.title.color = text;
                c.update('none');
            } catch (_) {}
            // Entering fullscreen resizes the chart's box through CSS alone — no window
            // resize — and a bare chart.resize() is a no-op there: it waits on the
            // ResizeObserver rather than measuring. Hand it the container's real size,
            // measured after the class has been applied, or the canvas keeps the 175px
            // it was born with and the wall display shows a strip of chart.
            requestAnimationFrame(function () {
                try {
                    const box = c.canvas && c.canvas.parentNode;
                    if (box && box.clientHeight) c.resize(box.clientWidth, box.clientHeight);
                } catch (_) {}
            });
        }
        document.addEventListener('fullscreenchange', _onFsChange);
        document.addEventListener('webkitfullscreenchange', _onFsChange);

        // ── Pipeline trend chart: ORDERS COMPLETED per day (bars) ──
        //  Counts orders shipped/completed each day (by fulfilled_date) for Main
        //  Warehouse. Source: pick_anomaly_orders (scanner fetches
        //  saleList?Location=Main Warehouse → Main-only, full history). Continuous
        //  calendar so weekends show as 0 (no shipping then).
        async function loadPipelineChart(_retry) {
            try {
                if (!window.Chart) {                       // Chart.js not parsed yet — retry briefly
                    if ((_retry || 0) < 12) setTimeout(() => loadPipelineChart((_retry || 0) + 1), 400);
                    return;
                }
                const sb = window.supabase;
                if (!sb) return;
                const DAYS = 16;
                const aestDate = off => new Date(Date.now() + 10 * 3600000 - off * 86400000); // shifted so UTC parts = AEST
                const lo = aestDate(DAYS - 1).toISOString().slice(0, 10), hi = aestDate(0).toISOString().slice(0, 10);
                // ── sales + FG completed with error counts (pick_anomaly_orders by fulfilled_date) ──
                const salesCounts = {}, salesErrCounts = {}, fgCounts = {}, fgErrCounts = {};
                const pullEntity = async (entity, counts, errCounts) => {
                    let acc = [], from = 0;
                    for (;;) {
                        const r = await sb.from('pick_anomaly_orders')
                            .select('fulfilled_date,anomaly_picks')
                            .eq('entity_type', entity)
                            .gte('fulfilled_date', lo).lte('fulfilled_date', hi)
                            .range(from, from + 999);
                        if (r.error) break;
                        acc.push(...(r.data || []));
                        if (!r.data || r.data.length < 1000) break;
                        from += 1000;
                    }
                    acc.forEach(o => { if (!o.fulfilled_date) return;
                        counts[o.fulfilled_date] = (counts[o.fulfilled_date] || 0) + 1;
                        if ((o.anomaly_picks || 0) > 0) errCounts[o.fulfilled_date] = (errCounts[o.fulfilled_date] || 0) + 1; });
                };
                await pullEntity('sale', salesCounts, salesErrCounts);
                await pullEntity('assembly', fgCounts, fgErrCounts);

                // ── transfers dispatched from Main to a BRANCH (stock_transfer movements) ──
                // cin7_mirror.stock_movements type='stock_transfer' (dispatch, same source
                // as the modal). Branch = customer warehouses only; Project/Gateway/Ghost/
                // Faulty excluded (we don't monitor project transfers).
                const trBranchByDay = {};
                try {
                    const sinceUtc = new Date(Date.now() - DAYS * 86400000).toISOString();
                    let mv = [], mf = 0;
                    for (;;) {
                        const t = await sb.schema('cin7_mirror').from('stock_movements')
                            .select('reference_number,to_location,quantity,detected_at')
                            .eq('movement_type', 'stock_transfer').gte('detected_at', sinceUtc).range(mf, mf + 999);
                        if (t.error) break;
                        mv.push(...(t.data || []));
                        if (!t.data || t.data.length < 1000) break;
                        mf += 1000;
                    }
                    const destOf = {};
                    mv.forEach(m => { if (m.quantity > 0 && m.to_location && !String(m.to_location).startsWith('Main Warehouse')) destOf[m.reference_number] = m.to_location; });
                    mv.forEach(m => {
                        if (!(m.quantity < 0)) return;                 // OUT side dates it by dispatch
                        const dest = destOf[m.reference_number]; if (!dest) return;
                        if (/project|gateway|ghost|faulty/i.test(dest)) return;   // branches only
                        const day = new Date(new Date(m.detected_at).getTime() + 10 * 3600000).toISOString().slice(0, 10);
                        (trBranchByDay[day] ??= new Set()).add(m.reference_number);
                    });
                } catch (_) { /* transfers optional */ }

                const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                const labels = [], salesData = [], salesErr = [], trBranchData = [], fgData = [], fgErr = [];
                for (let i = DAYS - 1; i >= 0; i--) {
                    const d = aestDate(i);
                    const key = d.toISOString().slice(0, 10);
                    labels.push(`${dow[d.getUTCDay()]} ${d.getUTCDate()}`);
                    salesData.push(salesCounts[key] || 0); salesErr.push(salesErrCounts[key] || 0);
                    trBranchData.push(trBranchByDay[key] ? trBranchByDay[key].size : 0);
                    fgData.push(fgCounts[key] || 0); fgErr.push(fgErrCounts[key] || 0);
                }
                const pct = (e, t) => t ? Math.round(100 * e / t) : 0;
                const cv = document.getElementById('pipelineChart');
                if (!cv) return;
                if (window.__pipelineChart) window.__pipelineChart.destroy();
                window.__pipelineChart = new Chart(cv.getContext('2d'), {
                    type: 'bar',
                    data: {
                        labels,
                        datasets: [
                            { label: 'Sales orders', data: salesData, stack: 'wh', backgroundColor: 'rgba(34,197,94,.8)', borderRadius: 3 },
                            { label: 'TR — branches', data: trBranchData, stack: 'wh', backgroundColor: 'rgba(59,130,246,.85)', borderRadius: 3 },
                            { label: 'FG / Assembly', data: fgData, stack: 'wh', backgroundColor: 'rgba(139,92,246,.85)', borderRadius: 3 },
                        ],
                    },
                    options: {
                        responsive: true, maintainAspectRatio: false,
                        interaction: { mode: 'index', intersect: false },
                        plugins: {
                            legend: { display: true, position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
                            tooltip: {
                                callbacks: {
                                    label: (c) => {
                                        const i = c.dataIndex, l = c.dataset.label;
                                        if (l === 'TR — branches') return `TR branches: ${trBranchData[i]}`;
                                        if (l.startsWith('FG')) return `FG: ${fgData[i]} · ${fgErr[i]} errors (${pct(fgErr[i], fgData[i])}%)`;
                                        return `Sales: ${salesData[i]} · ${salesErr[i]} errors (${pct(salesErr[i], salesData[i])}%)`;
                                    },
                                },
                            },
                        },
                        scales: {
                            x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } },
                            y: { stacked: true, beginAtZero: true, grid: { color: '#eef2f7' }, title: { display: true, text: 'Count' } },
                        },
                    },
                });
                const note = document.getElementById('whChartNote');
                if (note) note.textContent = `· Main Warehouse · Sales + TR (branches) + FG per day · last ${DAYS} days`;
                // The 5-min rebuild recreates the chart with the light palette — re-apply the
                // dark wall palette if we're in fullscreen, or the axes vanish on the navy.
                const _fsCard = document.getElementById('whPipelineCard');
                if ((document.fullscreenElement || document.webkitFullscreenElement) === _fsCard) _paintChart(true);
            } catch (e) { console.warn('pipeline chart error', e); }
        }

        // ── Modal — Errors (anomalies) + Transfers (branches only), per day ──
        let __pickErrRows = [], __trRows = [], __scanMap = {}, __pickErrMethod = 'all', __modalTab = 'errors';
        const __esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
        async function openPickErrors() {
            const ov = document.getElementById('pickErrOverlay');
            if (ov) ov.classList.add('active');
            const body = document.getElementById('pickErrBody');
            if (body) body.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:20px;color:#64748b">Loading…</td></tr>';
            try {
                const sb = window.supabase; if (!sb) return;
                const DAYS = 16;
                const aestDate = off => new Date(Date.now() + 10 * 3600000 - off * 86400000);
                const lo = aestDate(DAYS - 1).toISOString().slice(0, 10), hi = aestDate(0).toISOString().slice(0, 10);
                try { const sr = await fetch('/api/scanner-activity'); __scanMap = (await sr.json()).scanned || {}; } catch (_) { __scanMap = {}; }
                // ── errors (order/FG anomalies, per line) ──
                let orows = [], from = 0;
                for (;;) {
                    const r = await sb.from('pick_anomaly_orders')
                        .select('order_number,entity_type,fulfilled_date,picks')
                        .gt('anomaly_picks', 0).gte('fulfilled_date', lo).lte('fulfilled_date', hi)
                        .order('fulfilled_date', { ascending: false }).range(from, from + 999);
                    if (r.error) break;
                    orows.push(...(r.data || []));
                    if (!r.data || r.data.length < 1000) break;
                    from += 1000;
                }
                const hasScan = Object.keys(__scanMap).length > 0;
                __pickErrRows = [];
                orows.forEach(o => (o.picks || []).forEach(p => {
                    if (p.status !== 'anomaly') return;
                    const isFg = o.entity_type === 'assembly', scan = __scanMap[o.order_number];
                    __pickErrRows.push({ date: o.fulfilled_date, order: o.order_number,
                        type: isFg ? 'FG' : 'Sales',
                        method: isFg ? 'FG' : (hasScan ? (scan ? 'Scanner' : 'Manual') : '—'),
                        operator: scan ? scan.op : '',
                        sku: p.sku || '', qty: p.qty, from: p.bin || '', pickface: p.expectedBin || '' });
                }));
                // ── transfers OUT of Main to a BRANCH (per movement line) ──
                __trRows = [];
                try {
                    const sinceUtc = new Date(Date.now() - DAYS * 86400000).toISOString();
                    let mv = [], mf = 0;
                    for (;;) {
                        const t = await sb.schema('cin7_mirror').from('stock_movements')
                            .select('reference_number,sku,from_location,to_location,quantity,detected_at')
                            .eq('movement_type', 'stock_transfer').gte('detected_at', sinceUtc).range(mf, mf + 999);
                        if (t.error) break;
                        mv.push(...(t.data || []));
                        if (!t.data || t.data.length < 1000) break;
                        mf += 1000;
                    }
                    const destOf = {};
                    mv.forEach(m => { if (m.quantity > 0 && m.to_location && !String(m.to_location).startsWith('Main Warehouse')) destOf[m.reference_number] = m.to_location; });
                    mv.forEach(m => {
                        if (!(m.quantity < 0)) return;
                        if (!String(m.from_location || '').includes('Main')) return;
                        const dest = destOf[m.reference_number]; if (!dest) return;
                        if (/project|gateway|ghost|faulty/i.test(dest)) return;      // branches only
                        const day = new Date(new Date(m.detected_at).getTime() + 10 * 3600000).toISOString().slice(0, 10);
                        if (day > hi) return;                                        // skip future-dated
                        __trRows.push({ date: day, tr: m.reference_number, dest, sku: m.sku || '', qty: Math.abs(m.quantity || 0) });
                    });
                } catch (_) { __trRows = []; }
                __modalTab = 'errors';
                document.querySelectorAll('#pickErrOverlay [data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === 'errors'));
                document.getElementById('pickErrMethodGroup').style.display = '';
                _rebuildModalDays();
                renderCurrentTab();
            } catch (e) {
                if (body) body.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:20px;color:#ef4444">Error: ${e.message}</td></tr>`;
            }
        }
        function closePickErrors() { const ov = document.getElementById('pickErrOverlay'); if (ov) ov.classList.remove('active'); }
        function _rebuildModalDays() {
            const dsel = document.getElementById('pickErrDay'); if (!dsel) return;
            const src = __modalTab === 'transfers' ? __trRows : __pickErrRows;
            const uniq = [...new Set(src.map(r => r.date))].filter(Boolean).sort().reverse();
            const cur = dsel.value;
            dsel.innerHTML = uniq.map(d => `<option value="${d}">${d}</option>`).join('');
            if (uniq.includes(cur)) dsel.value = cur;
        }
        function setModalTab(btn) {
            __modalTab = btn.dataset.tab;
            btn.parentElement.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b === btn));
            document.getElementById('pickErrMethodGroup').style.display = __modalTab === 'errors' ? '' : 'none';
            const h = document.querySelector('#pickErrOverlay h2'); if (h) h.textContent = __modalTab === 'transfers' ? '🔄 Branch Transfers' : '⚠️ Pick Errors';
            _rebuildModalDays();
            renderCurrentTab();
        }
        function setPickErrMethod(btn) { __pickErrMethod = btn.dataset.method; btn.parentElement.querySelectorAll('.tr-direction-btn').forEach(b => b.classList.toggle('active', b === btn)); renderPickErrors(); }
        function renderCurrentTab() { if (__modalTab === 'transfers') renderTransfers(); else renderPickErrors(); }
        function renderPickErrors() {
            document.getElementById('pickErrHead').innerHTML = '<th>Date</th><th>Order</th><th>Type</th><th>Operator</th><th>Method</th><th>SKU</th><th>Qty</th><th>Picked from</th><th>Pickface</th>';
            const day = (document.getElementById('pickErrDay').value) || '';
            const q = (document.getElementById('pickErrSearch').value || '').toLowerCase();
            const dayRows = __pickErrRows.filter(r => r.date === day);
            let rows = dayRows;
            if (__pickErrMethod !== 'all') rows = rows.filter(r => r.method === __pickErrMethod);
            if (q) rows = rows.filter(r => `${r.order} ${r.sku} ${r.from} ${r.pickface} ${r.operator}`.toLowerCase().includes(q));
            document.getElementById('pickErrCount').textContent = `${rows.length} errors · ${day}`;
            document.getElementById('pickErrEmpty').style.display = rows.length ? 'none' : 'block';
            const by = { Scanner: 0, Manual: 0, FG: 0 };
            dayRows.forEach(r => { if (by[r.method] != null) by[r.method]++; });
            const rl = document.getElementById('pickErrRates');
            if (rl) rl.textContent = `${day} — 📟 ${by.Scanner} scanner · ✋ ${by.Manual} manual · 🟣 ${by.FG} FG`;
            const mColor = m => m === 'Scanner' ? 'background:#dbeafe;color:#1e40af' : m === 'Manual' ? 'background:#fee2e2;color:#991b1b' : m === 'FG' ? 'background:#ede9fe;color:#6d28d9' : 'background:#f1f5f9;color:#64748b';
            document.getElementById('pickErrBody').innerHTML = rows.map(r => `<tr>
                <td>${__esc(r.date)}</td>
                <td><strong>${__esc(r.order)}</strong></td>
                <td>${__esc(r.type)}</td>
                <td>${__esc(r.operator) || '<span style="color:#cbd5e1">—</span>'}</td>
                <td><span style="padding:1px 6px;border-radius:4px;font-size:11px;${mColor(r.method)}">${__esc(r.method)}</span></td>
                <td>${__esc(r.sku)}</td>
                <td style="text-align:right">${__esc(r.qty)}</td>
                <td>${__esc(r.from)}</td>
                <td>${__esc(r.pickface)}</td>
            </tr>`).join('');
        }
        function renderTransfers() {
            document.getElementById('pickErrHead').innerHTML = '<th>Date</th><th>TR #</th><th>Destination</th><th>SKU</th><th>Qty</th>';
            const day = (document.getElementById('pickErrDay').value) || '';
            const q = (document.getElementById('pickErrSearch').value || '').toLowerCase();
            const dayRows = __trRows.filter(r => r.date === day);
            let rows = dayRows;
            if (q) rows = rows.filter(r => `${r.tr} ${r.dest} ${r.sku}`.toLowerCase().includes(q));
            document.getElementById('pickErrCount').textContent = `${rows.length} lines · ${day}`;
            document.getElementById('pickErrEmpty').style.display = rows.length ? 'none' : 'block';
            const nTr = new Set(dayRows.map(r => r.tr)).size;
            const rl = document.getElementById('pickErrRates');
            if (rl) rl.textContent = `${day} — 🔵 ${nTr} branch transfers · ${dayRows.length} lines`;
            document.getElementById('pickErrBody').innerHTML = rows.map(r => `<tr>
                <td>${__esc(r.date)}</td>
                <td><strong>${__esc(r.tr)}</strong></td>
                <td>${__esc(r.dest)}</td>
                <td>${__esc(r.sku)}</td>
                <td style="text-align:right">${__esc(r.qty)}</td>
            </tr>`).join('');
        }

        // ── Import scanner report (client-side xlsx/csv parse → persist operator map) ──
        function ensureXLSX() {
            return new Promise((resolve, reject) => {
                if (window.XLSX) return resolve();
                const s = document.createElement('script');
                s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
                s.onload = () => resolve();
                s.onerror = () => reject(new Error('could not load xlsx library'));
                document.head.appendChild(s);
            });
        }
        function _parseReportRows(aoa) {
            const MON = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
            const toISO = (v) => {
                if (v == null || v === '') return '';
                if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
                const s = String(v).trim();
                let m = /(\d{2})-([A-Za-z]{3})-(\d{4})/.exec(s); if (m && MON[m[2]]) return `${m[3]}-${MON[m[2]]}-${m[1]}`;
                m = /(\d{4})-(\d{2})-(\d{2})/.exec(s); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
                m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s); if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
                if (/^\d{5}$/.test(s)) { const dt = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000); return dt.toISOString().slice(0, 10); }
                return '';
            };
            // report period date from the "From:" metadata line — fallback for every row
            let reportDate = '';
            for (let i = 0; i < Math.min(aoa.length, 12) && !reportDate; i++) {
                for (const c of (aoa[i] || [])) { if (/from:/i.test(String(c))) { const iso = toISO(String(c).replace(/.*from:\s*/i, '')); if (iso) { reportDate = iso; break; } } }
            }
            // header row + column indices
            let start = 0, col = {};
            for (let i = 0; i < Math.min(aoa.length, 20); i++) {
                const cs = (aoa[i] || []).map(c => String(c == null ? '' : c).toLowerCase().trim());
                if (cs.some(c => c.includes('sale order')) && cs.some(c => c === 'user')) {
                    start = i + 1;
                    cs.forEach((c, idx) => {
                        if (c === 'user') col.user = idx;
                        else if (c === 'date') col.date = idx;
                        else if (c.includes('sale order')) col.so = idx;
                        else if (c.includes('sku')) col.sku = idx;
                        else if (c.includes('time')) col.time = idx;
                    });
                    break;
                }
            }
            const scanned = {}, days = new Set(), ops = {};
            let totalSkus = 0, totalMin = 0;
            for (let i = start; i < aoa.length; i++) {
                const raw = aoa[i]; if (!Array.isArray(raw)) continue;
                const cells = raw.map(c => (c instanceof Date) ? c : String(c == null ? '' : c).trim());
                const email = (col.user != null ? String(cells[col.user] || '') : (cells.find(c => /@rapidled/i.test(String(c))) || ''));
                const soCell = (col.so != null ? String(cells[col.so] || '') : (cells.find(c => /^SO-\d+$/.test(String(c).trim())) || ''));
                if (!/@rapidled\.com\.au/i.test(String(email)) || !/^SO-\d+$/.test(String(soCell).trim())) continue;
                const so = String(soCell).trim();
                const rawDate = col.date != null ? cells[col.date] : cells.find(c => toISO(c));
                const date = toISO(rawDate) || reportDate;
                const op = String(email).replace(/@rapidled\.com\.au/i, '').replace('project.scanner', 'scanner');
                const skus = col.sku != null ? (parseFloat(String(cells[col.sku]).replace(/,/g, '')) || 0) : 0;
                const min = col.time != null ? (parseFloat(String(cells[col.time]).replace(/[^\d.]/g, '')) || 0) : 0;
                scanned[so] = { op, date, skus, min }; if (date) days.add(date);
                ops[op] = ops[op] || { orders: 0, skus: 0, min: 0 };
                ops[op].orders++; ops[op].skus += skus; ops[op].min += min;
                totalSkus += skus; totalMin += min;
            }
            return { scanned, days: [...days].sort(), stats: { orders: Object.keys(scanned).length, ops, totalSkus, totalMin } };
        }
        let __importParsed = null;
        function openImportModal() {
            __importParsed = null;
            const sum = document.getElementById('importSummary'); if (sum) sum.innerHTML = '';
            const drop = document.getElementById('importDrop'); if (drop) { drop.style.display = ''; drop.style.borderColor = '#cbd5e1'; drop.style.background = ''; }
            const btn = document.getElementById('importConfirmBtn'); if (btn) { btn.disabled = true; btn.style.opacity = '.5'; }
            const ov = document.getElementById('importOverlay'); if (ov) ov.classList.add('active');
            _wireImportDrop();
        }
        function _wireImportDrop() {
            const drop = document.getElementById('importDrop'); if (!drop || drop._wired) return;
            drop._wired = true;
            ['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.style.borderColor = '#3b82f6'; drop.style.background = '#eff6ff'; }));
            ['dragleave', 'dragend'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.style.borderColor = '#cbd5e1'; drop.style.background = ''; }));
            drop.addEventListener('drop', e => { e.preventDefault(); drop.style.borderColor = '#cbd5e1'; drop.style.background = ''; const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) _handleImportFile(f); });
        }
        async function importScannerReport(input) {
            const file = input && input.files && input.files[0];
            if (input) input.value = '';
            if (file) await _handleImportFile(file);
        }
        async function _handleImportFile(file) {
            const sum = document.getElementById('importSummary');
            try {
                if (sum) sum.innerHTML = '<div style="color:#64748b;font-size:13px;padding:8px 0">Reading “' + __esc(file.name) + '”…</div>';
                await ensureXLSX();
                const buf = await file.arrayBuffer();
                const wb = XLSX.read(buf, { type: 'array', cellDates: true });
                const ws = wb.Sheets[wb.SheetNames[0]];
                const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
                const parsed = _parseReportRows(aoa);
                if (!parsed.stats.orders) { if (sum) sum.innerHTML = '<div style="color:#ef4444;font-size:13px;padding:8px 0">No picking rows found — is this the InventoryWarehouseDetails report?</div>'; return; }
                parsed.fileName = file.name;
                try { const c = await (await fetch('/api/scanner-activity')).json(); parsed.existingDays = c.days || []; } catch (_) { parsed.existingDays = []; }
                __importParsed = parsed;
                _showImportPreview(parsed);
            } catch (e) { if (sum) sum.innerHTML = `<div style="color:#ef4444;font-size:13px;padding:8px 0">Error: ${__esc(e.message)}</div>`; }
        }
        function _showImportPreview(p) {
            const s = p.stats;
            const opRows = Object.entries(s.ops).sort((a, b) => b[1].orders - a[1].orders).map(([op, v]) =>
                `<tr><td>${__esc(op)}</td><td style="text-align:right">${v.orders}</td><td style="text-align:right">${Math.round(v.skus).toLocaleString()}</td><td style="text-align:right">${v.min.toFixed(1)}m</td></tr>`).join('');
            const dayChips = (p.days.length ? p.days : ['(no date found)']).map(d => {
                const already = p.existingDays.includes(d);
                return `<span style="display:inline-block;padding:2px 9px;margin:2px;border-radius:6px;font-size:12px;${already ? 'background:#fef3c7;color:#92400e' : 'background:#dcfce7;color:#166534'}">${__esc(d)} ${d.includes('no date') ? '' : (already ? '· will update' : '· new')}</span>`;
            }).join('');
            const tile = (n, l) => `<div style="text-align:center;padding:0 6px"><div style="font-size:22px;font-weight:600;line-height:1">${n}</div><div style="font-size:11px;color:#64748b">${l}</div></div>`;
            document.getElementById('importSummary').innerHTML = `
                <div style="font-size:13px;color:#475569;margin-bottom:10px">📄 <strong>${__esc(p.fileName)}</strong></div>
                <div style="display:flex;gap:10px;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap">
                    ${tile(s.orders, 'picked orders')}${tile(Object.keys(s.ops).length, 'operators')}${tile(Math.round(s.totalSkus).toLocaleString(), 'SKUs picked')}${tile(Math.round(s.totalMin) + 'm', 'time tracked')}
                </div>
                <div style="font-size:12px;color:#475569;margin-bottom:4px">Day(s) this import will register:</div>
                <div style="margin-bottom:14px">${dayChips}</div>
                <table class="tr-table" style="min-width:0"><thead><tr><th>Operator</th><th style="text-align:right">Orders</th><th style="text-align:right">SKUs</th><th style="text-align:right">Time</th></tr></thead><tbody>${opRows}</tbody></table>`;
            const drop = document.getElementById('importDrop'); if (drop) drop.style.display = 'none';
            const btn = document.getElementById('importConfirmBtn'); if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
        }
        function closeImportModal() { document.getElementById('importOverlay').classList.remove('active'); }
        async function confirmImport() {
            if (!__importParsed) return;
            const btn = document.getElementById('importConfirmBtn');
            btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Importing…';
            try {
                const res = await fetch('/api/scanner-activity/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scanned: __importParsed.scanned, days: __importParsed.days }) });
                const j = await res.json();
                if (!res.ok || !j.success) throw new Error(j.error || 'import failed');
                closeImportModal();
                openPickErrors();
            } catch (e) { alert('Import error: ' + e.message); }
            finally { btn.disabled = false; btn.textContent = orig; }
        }

        // ══════════════════════════════════════════════════════
        // ORDERS MODAL LOGIC
        // ══════════════════════════════════════════════════════
        let _ordersTypeFilter = 'all';
        let _ordersViewFilter = 'active'; // 'active' or 'completed'
        let _ordersStatusFilter = 'all'; // 'all' or specific status
        let _ordersDateSort = 'desc'; // 'desc' = newest first, 'asc' = oldest first
        let _ordersStageFilter = 'all'; // 'all' | 'ordered' | 'picking' | 'topack' (from a clicked flow tile)
        const _STAGE_LABEL = { ordered: 'Ordered', picking: 'Picking', topack: 'To Pack', completed: 'Completed',
            aged: 'Aged — awaiting pick > 2d', backorder: 'Backordered', packbacklog: 'Pack backlog', dispatch: 'Dispatch backlog' };
        const _activeStatuses = ['ORDERED', 'PICKING', 'PICKED', 'PACKING', 'BACKORDERED'];
        const _completedModalStatuses = ['COMPLETED'];

        function openOrdersModal(stage) {
            _ordersStageFilter = stage || 'all';
            _ordersViewFilter = stage === 'completed' ? 'completed' : 'active';
            _ordersStatusFilter = 'all';
            _ordersTypeFilter = 'all';
            // reflect the scoped state on the modal chrome
            document.querySelectorAll('.orders-filter-btn[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === _ordersViewFilter));
            document.querySelectorAll('.orders-filter-btn[data-filter]').forEach(b => b.classList.toggle('active', b.dataset.filter === 'all'));
            const label = _ordersViewFilter === 'completed' ? 'Completed' : 'Created';
            const dh = document.getElementById('dateHeader'); if (dh) dh.innerHTML = label + ' ' + (_ordersDateSort === 'desc' ? '▼' : '▲');
            _setOrdersModalScope();
            document.getElementById('ordersModalOverlay').classList.add('active');
            _mountModalInFs('ordersModalOverlay');   // clickable on the wall when in fullscreen
            document.body.style.overflow = 'hidden';
            renderOrdersTable();
            _loadStageTimes();   // fetch per-stage times, then re-render with them
        }
        // Show which flow stage the modal is scoped to (title chip)
        function _setOrdersModalScope() {
            const h = document.getElementById('ordersModalTitle'); if (!h) return;
            const lbl = _STAGE_LABEL[_ordersStageFilter];
            const scope = window.__whFocusValue && window.__whFocusValue !== '__all__' ? window.__whFocusValue : (window.__whFocusValue === '__all__' ? 'All warehouses' : '');
            const bits = [lbl, scope].filter(Boolean).join(' · ');
            h.innerHTML = bits ? `Order Pipeline <span style="color:#64748b;font-weight:500">— ${bits}</span>` : 'Order Pipeline';
        }
        function closeOrdersModal() {
            document.getElementById('ordersModalOverlay').classList.remove('active');
            _restoreModal('ordersModalOverlay');
            document.body.style.overflow = '';
        }
        function toggleViewFilter(btn) {
            document.querySelectorAll('.orders-filter-btn[data-view]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _ordersViewFilter = btn.dataset.view;
            _ordersStatusFilter = 'all'; // reset status filter on view change
            _ordersStageFilter = 'all';  // manual view change clears the flow-tile scope
            _setOrdersModalScope();
            const label = _ordersViewFilter === 'completed' ? 'Completed' : 'Created';
            document.getElementById('dateHeader').innerHTML = label + ' ' + (_ordersDateSort === 'desc' ? '▼' : '▲');
            renderOrdersTable();
        }
        function toggleDateSort() {
            _ordersDateSort = _ordersDateSort === 'desc' ? 'asc' : 'desc';
            const label = _ordersViewFilter === 'completed' ? 'Completed' : 'Created';
            document.getElementById('dateHeader').innerHTML = label + ' ' + (_ordersDateSort === 'desc' ? '▼' : '▲');
            renderOrdersTable();
        }
        function toggleStatusDropdown(e) {
            e.stopPropagation();
            const dd = document.getElementById('statusDropdown');
            const isOpen = dd.classList.contains('open');
            dd.classList.toggle('open');
            if (!isOpen) buildStatusDropdown();
        }
        function buildStatusDropdown() {
            const dd = document.getElementById('statusDropdown');
            const isCompleted = _ordersViewFilter === 'completed';
            const statuses = isCompleted ? ['COMPLETED'] : _activeStatuses;
            const options = ['all', ...statuses];
            dd.innerHTML = options.map(s => {
                const label = s === 'all' ? 'All Statuses' : s;
                const cls = _ordersStatusFilter === s ? 'active' : '';
                return `<button class="status-dropdown-btn ${cls}" onclick="selectStatusFilter('${s}', event)">${label}</button>`;
            }).join('');
        }
        function selectStatusFilter(status, e) {
            e.stopPropagation();
            _ordersStatusFilter = status;
            document.getElementById('statusDropdown').classList.remove('open');
            renderOrdersTable();
        }
        // Close dropdown when clicking outside
        document.addEventListener('click', () => {
            const dd = document.getElementById('statusDropdown');
            if (dd) dd.classList.remove('open');
        });
        function toggleOrderFilter(btn) {
            document.querySelectorAll('.orders-filter-btn[data-filter="all"],.orders-filter-btn[data-filter="SO"],.orders-filter-btn[data-filter="TR"]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _ordersTypeFilter = btn.dataset.filter;
            _ordersStageFilter = 'all';  // manual type change clears the flow-tile scope
            _setOrdersModalScope();
            renderOrdersTable();
        }

        // Per-stage transition times (from cin7_mirror.order_stage_events). The order's CURRENT
        // stage + when it entered it — shown AM/PM in the list.
        const _CUR_DONE = ['COMPLETED', 'VOIDED', 'CLOSED', 'INVOICED'];
        function _curStage(r) {
            if (r.type !== 'SO' || _CUR_DONE.includes(r.status)) return null;
            if (r.status === 'BACKORDERED') return 'backordered';
            if (r.pack_status === 'PACKED') return 'packed';
            if (r.pack_status === 'PACKING') return 'packing';
            if (r.pick_status === 'PICKED') return 'picked';
            if (r.pick_status === 'PICKING') return 'picking';
            if (r.status === 'ORDERED') return 'ordered';
            return null;
        }
        function _fmtStageTime(iso) {
            if (!iso) return '';
            const a = new Date(new Date(iso).getTime() + 10 * 3600000);   // AEST
            let h = a.getUTCHours(); const ap = h < 12 ? 'am' : 'pm'; h = h % 12 || 12;
            const t = `${h}:${String(a.getUTCMinutes()).padStart(2, '0')}${ap}`;
            const day = a.toISOString().slice(0, 10);
            const today = new Date(Date.now() + 10 * 3600000).toISOString().slice(0, 10);
            return day === today ? t : `${day.slice(8, 10)}/${day.slice(5, 7)} ${t}`;
        }
        function _loadStageTimes() {
            try {
                const ids = [...new Set((window.__pipelineData || []).map(r => r.id).filter(Boolean))];
                if (!ids.length || !window.supabase) return;
                window.supabase.schema('cin7_mirror').from('order_stage_events').select('order_id,stage,at').in('order_id', ids)
                    .then(({ data }) => { const m = {}; (data || []).forEach(e => { m[e.order_id + '|' + e.stage] = e.at; }); window.__stageAt = m; renderOrdersTable(); })
                    .catch(() => {});
            } catch (e) {}
        }

        function renderOrdersTable() {
            const data = window.__pipelineData || [];
            const search = (document.getElementById('ordersSearch')?.value || '').toLowerCase();
            const isCompleted = _ordersViewFilter === 'completed';
            // For completed view, limit to last 7 days
            const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
            const DONE = ['COMPLETED', 'VOIDED', 'CLOSED', 'INVOICED'];

            // What belongs in each view. Active = genuine pipeline only — exclude
            // packed/invoiced/completed/backordered so done-from-other-days don't
            // clutter the daily view (the chart handles history).
            // Active view = every OPEN order, all stages — including backordered and
            // packed-awaiting-dispatch, so the modal shows the full picture (the funnel
            // tiles still scope to one stage via inStage below).
            const inView = r => {
                if (isCompleted) return r.status === 'COMPLETED' && !(r.completed_at && r.completed_at < sevenDaysAgo);
                return !DONE.includes(r.status);
            };

            // Stage scope (set when a flow tile is clicked). 'completed' is already
            // handled by the completed view above, so only the 3 active stages gate here.
            const _ageD = r => r.order_date ? Math.floor((Date.now() - new Date(r.order_date + 'T00:00:00').getTime()) / 86400000) : 0;
            const inStage = r => {
                if (r.type !== 'SO') return false;   // the flow funnel is sales-orders only (TR live in the footer)
                if (_ordersStageFilter === 'ordered') return r.status === 'ORDERED' && r.pick_status !== 'PICKING' && r.pick_status !== 'PICKED';
                if (_ordersStageFilter === 'picking') return r.pick_status === 'PICKING';
                if (_ordersStageFilter === 'topack')  return r.pick_status === 'PICKED' && r.pack_status !== 'PACKED';
                // Exception scopes (from the Exceptions strip)
                if (_ordersStageFilter === 'backorder')   return r.status === 'BACKORDERED';
                if (_ordersStageFilter === 'aged')        return r.status === 'ORDERED' && r.pick_status !== 'PICKING' && r.pick_status !== 'PICKED' && _ageD(r) > 2;
                if (_ordersStageFilter === 'packbacklog') return r.pick_status === 'PICKED' && r.pack_status !== 'PACKED' && _ageD(r) > 2;
                if (_ordersStageFilter === 'dispatch')    return r.pack_status === 'PACKED' && String(r.ship_status || '').toUpperCase() !== 'SHIPPED';
                return true;
            };

            // When scoped to a flow tile, match that tile exactly (incl. aged/backordered
            // stuck orders) so the modal count == the tile and the stuck ones are visible.
            // Unscoped, keep the tidy daily "active" view.
            const useStage = _ordersStageFilter !== 'all' && _ordersStageFilter !== 'completed';
            let rows = data.filter(r => {
                if (useStage) { if (DONE.includes(r.status) || !inStage(r)) return false; }
                else if (!inView(r)) return false;
                if (_ordersStatusFilter !== 'all' && r.status !== _ordersStatusFilter) return false;
                if (_ordersTypeFilter !== 'all' && r.type !== _ordersTypeFilter) return false;
                if (search) {
                    const hay = `${r.number} ${r.customer||''} ${r.status} ${r.reference||''} ${r.to_location||''}`.toLowerCase();
                    if (!hay.includes(search)) return false;
                }
                return true;
            });

            // Sort by date using current direction
            const dir = _ordersDateSort === 'desc' ? -1 : 1;
            if (isCompleted) {
                rows.sort((a, b) => dir * (a.completed_at || '').localeCompare(b.completed_at || ''));
            } else {
                rows.sort((a, b) => dir * (a.order_date || '').localeCompare(b.order_date || ''));
            }

            const tbody = document.getElementById('ordersTableBody');
            const empty = document.getElementById('ordersEmpty');
            const countEl = document.getElementById('ordersCount');
            const totalInView = useStage ? data.filter(r => !DONE.includes(r.status) && inStage(r)).length : data.filter(inView).length;
            if (countEl) countEl.textContent = `${rows.length}` + (rows.length < totalInView ? ` of ${totalInView}` : '');

            if (rows.length === 0) {
                tbody.innerHTML = '';
                empty.style.display = '';
                return;
            }
            empty.style.display = 'none';

            const statusClass = s => (s || '').toLowerCase().replace(/\s+/g, '-');
            // Convert 24h to 12h AM/PM
            const to12h = (h24, mi) => {
                const ampm = h24 >= 12 ? 'pm' : 'am';
                const h12 = h24 % 12 || 12;
                return `${h12}:${mi}${ampm}`;
            };
            // Format created date — order_date only (Cin7 has no creation time)
            const fmtDate = (orderDate) => {
                if (!orderDate) return '—';
                const [y, m, d] = orderDate.split('-');
                return `${d}/${m}`;
            };
            const fmtCompletedDate = (completedAt) => {
                if (!completedAt) return '—';
                const dt = new Date(completedAt);
                const aest = new Date(dt.getTime() + 10 * 3600000);
                const dd = String(aest.getUTCDate()).padStart(2, '0');
                const mm = String(aest.getUTCMonth() + 1).padStart(2, '0');
                const timeStr = to12h(aest.getUTCHours(), String(aest.getUTCMinutes()).padStart(2, '0'));
                return `${dd}/${mm} <span style="color:#94a3b8;font-size:.7rem">${timeStr}</span>`;
            };

            window.__ordersById = {};
            tbody.innerHTML = rows.map(r => {
                window.__ordersById[r.id] = r;
                const numClass = r.type === 'TR' ? 'order-tr' : 'order-num';
                const fNum = r.fulfilment_number || 1;
                const numDisplay = fNum > 1 ? `${r.number} <span style="color:#94a3b8;font-weight:600;font-size:.78rem">#${fNum}</span>` : (r.number || '—');
                const custOrLoc = r.type === 'TR' ? `→ ${r.to_location || '?'}` : (r.customer || '—');
                const ageDays = r.order_date ? Math.floor((Date.now() - new Date(r.order_date + 'T00:00:00').getTime()) / 86400000) : 0;
                const aged = !isCompleted && ageDays > 2;    // single neutral emphasis, no red
                const dateCell = isCompleted ? fmtCompletedDate(r.completed_at)
                    : fmtDate(r.order_date) + (aged ? ` <span class="ord-age">· ${ageDays}d</span>` : '');
                const cs = _curStage(r);
                const stAt = (cs && window.__stageAt) ? window.__stageAt[r.id + '|' + cs] : null;
                const stageCell = stAt ? `<div class="ord-stagetime">${cs} · ${_fmtStageTime(stAt)}</div>` : '';
                return `<tr onclick="toggleOrderDetail('${r.id}', this)">
                    <td class="${numClass}"><span class="order-expand">›</span> ${numDisplay}</td>
                    <td class="ord-wh">${r.from_location || '—'}</td>
                    <td>${custOrLoc}</td>
                    <td><span class="ord-status">${r.status || '—'}</span>${stageCell}</td>
                    <td class="order-date">${dateCell}</td>
                </tr>`;
            }).join('');

        }

        // ── Expandable order detail (line items + status breakdown, lazy-loaded) ──
        function _odChip(label, val) {
            const v = val || '—';
            const u = String(v).toUpperCase();
            const cls = /NOT|^—|N\/A/.test(u) ? 'no'
                      : (/PARTIAL|PICKING|PACKING|TRANSIT|PENDING|AUTHORISED/.test(u) ? 'mid'
                      : (/PICKED|PACKED|SHIPPED|INVOICED/.test(u) ? 'ok' : 'mid'));
            return `<span class="od-chip ${cls}">${label}: ${v}</span>`;
        }
        function _odRender(r, lines, live) {
            live = live || {};
            const totalQty = lines.reduce((a, l) => a + (Number(l.quantity) || 0), 0);
            const money = v => '$' + Number(v).toLocaleString('en-AU', { maximumFractionDigits: 0 });
            const hasVal = lines.some(l => l.total != null);
            const pick = live.pick_status || r.pick_status;
            const pack = live.pack_status || r.pack_status;
            const ship = live.ship_status || r.ship_status;
            const inv  = live.invoice_status || r.invoice_status;
            const meta = [
                `<b>${r.customer || live.customer || (r.type === 'TR' ? 'Transfer' : '—')}</b>`,
                live.sales_rep ? `Rep: <b>${live.sales_rep}</b>` : '',
                r.reference ? `Ref: <b>${r.reference}</b>` : '',
                r.type === 'TR' ? `<b>${r.from_location || '?'}</b> → <b>${r.to_location || '?'}</b>`
                                 : `From <b>${r.from_location || '?'}</b>`,
                live.ship_to ? `Ship to: <b>${live.ship_to}</b>` : '',
                live.carrier ? `Carrier: <b>${live.carrier}</b>` : '',
                r.order_date ? `Ordered: <b>${r.order_date}</b>` : '',
                (live.order_total != null) ? `Order total: <b>${money(live.order_total)}</b>` : '',
                (r.fulfilment_number > 1) ? `Fulfilment <b>#${r.fulfilment_number}</b>` : ''
            ].filter(Boolean).join(' · ');
            const linesHtml = lines.length ? `
                <table class="od-lines"><thead><tr>
                    <th>SKU</th><th>Product</th><th class="num">Qty</th><th class="num">B/O</th>${hasVal ? '<th class="num">Value</th>' : ''}
                </tr></thead><tbody>
                ${lines.map(l => `<tr>
                    <td style="font-weight:600">${l.sku || '—'}</td>
                    <td>${l.product_name || ''}</td>
                    <td class="num">${l.quantity ?? ''}</td>
                    <td class="num">${l.backorder_quantity || ''}</td>
                    ${hasVal ? `<td class="num">${l.total != null ? money(l.total) : ''}</td>` : ''}
                </tr>`).join('')}
                </tbody><tfoot><tr>
                    <td colspan="2" style="text-align:right;font-weight:700">Total</td>
                    <td class="num" style="font-weight:700">${totalQty}</td><td></td>${hasVal ? '<td></td>' : ''}
                </tr></tfoot></table>`
                : `<div class="od-empty">No product lines found for this order.</div>`;
            const srcBadge = live.source
                ? ` <span style="font-size:.58rem;font-weight:700;color:#0369a1;background:#e0f2fe;padding:2px 7px;border-radius:999px">via Cin7${live.source === 'cache' ? ' (cached)' : ' live'}</span>` : '';
            return `
                <div class="od-meta">${meta}</div>
                <div class="od-status">${_odChip('Pick', pick)}${_odChip('Pack', pack)}${_odChip('Ship', ship)}${_odChip('Invoice', inv)}</div>
                <div class="od-section-label">${lines.length} line${lines.length !== 1 ? 's' : ''}${srcBadge}</div>
                ${linesHtml}`;
        }
        async function toggleOrderDetail(id, tr) {
            const next = tr.nextElementSibling;
            if (next && next.classList.contains('order-detail-row')) { next.remove(); tr.classList.remove('expanded'); return; }
            tr.classList.add('expanded');
            const r = (window.__ordersById || {})[id] || {};
            const detail = document.createElement('tr');
            detail.className = 'order-detail-row';
            detail.innerHTML = `<td colspan="5"><div class="od-wrap"><div class="od-loading">Loading items…</div></div></td>`;
            tr.after(detail);
            let lines = [], live = null;
            try {
                const sb = window.supabase;
                const sel = 'line_no, sku, product_name, quantity, backorder_quantity, total';
                let q = await sb.schema('cin7_mirror').from('sale_lines').select(sel).eq('sale_id', id).order('line_no', { ascending: true });
                if (!q.error && q.data) lines = q.data;
                if (!lines.length && r.number) {
                    const q2 = await sb.schema('cin7_mirror').from('sale_lines').select(sel).eq('order_number', r.number).order('line_no', { ascending: true });
                    if (!q2.error && q2.data) lines = q2.data;
                }
                // Live Cin7 fallback for orders not yet mirrored (SOs by SaleID, TRs by TaskID)
                if (!lines.length && r.id) {
                    const w0 = detail.querySelector('.od-wrap');
                    if (w0) w0.innerHTML = '<div class="od-loading">Fetching items live from Cin7…</div>';
                    try {
                        const ep = r.type === 'TR'
                            ? '/api/transfer/' + encodeURIComponent(r.id)
                            : '/api/sale/' + encodeURIComponent(r.number || r.id) + '?id=' + encodeURIComponent(r.id);
                        const resp = await fetch(ep);
                        const j = await resp.json();
                        if (j && j.success) { lines = j.lines || []; live = { ...(j.header || {}), source: j.source }; }
                    } catch (e) {}
                }
            } catch (e) {}
            const wrap = detail.querySelector('.od-wrap');
            if (wrap) wrap.innerHTML = _odRender(r, lines, live);
        }

        // Close modal with Escape key
        document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeOrdersModal(); closeTransfersModal(); closeTrLines(); } });

        // ══════════════════════════════════════════════════════
        // TRANSFERS MODAL LOGIC
        // ══════════════════════════════════════════════════════
        let _trDirectionFilter = 'all'; // 'all', 'outbound', 'inbound'
        let _trStatusFilter = 'all';    // 'all', 'IN TRANSIT', 'ORDERED'

        // Inline Transfers-Out list on the dashboard (click a row → editable pick sheet).
        // Warehouse focus selector — built once from the data, Main first, then the rest, then "All".
        function populateWhSelector(pipeline, focus) {
            const sel = document.getElementById('whFocusSel'); if (!sel || sel.dataset.built) return;
            const MAIN = 'Main Warehouse';
            const whs = [...new Set((pipeline || []).map(r => r.from_location).filter(Boolean))]
                .filter(w => w !== MAIN).sort((a, b) => a.localeCompare(b));
            sel.innerHTML = [`<option value="${MAIN}">Main Warehouse</option>`]
                .concat(whs.map(w => `<option value="${w}">${w}</option>`))
                .concat([`<option value="__all__">All warehouses</option>`]).join('');
            sel.value = focus || MAIN;
            sel.dataset.built = '1';
        }
        function setWhFocus(v) { window.__whFocus = v; if (window.reloadWhBoard) window.reloadWhBoard(); }

        // Paint one exception tile: value + sub + a severity class (crit/warn), muted when zero.
        function setExc(id, n, sub, sev) {
            const tile = document.getElementById(id); if (!tile) return;
            const v = document.getElementById(id + 'Val'); if (v) v.textContent = n;
            const s = document.getElementById(id + 'Sub'); if (s) s.textContent = sub || '';
            tile.classList.remove('crit', 'warn', 'ok');
            tile.classList.add(n > 0 ? sev : 'ok');
        }

        function renderInlineTransfers(wh) {
            const MAIN_WH = (wh && wh !== '__all__') ? wh : 'Main Warehouse';
            const all = window.__transferData || [];
            const openS = s => ['ORDERED', 'IN TRANSIT'].includes(String(s || '').toUpperCase());
            const ordv = { 'IN TRANSIT': 0, 'ORDERED': 1 };
            const sortF = (a, b) => ((ordv[a.status] ?? 9) - (ordv[b.status] ?? 9)) || String(b.order_date || '').localeCompare(a.order_date || '');
            const fmt = d => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); return m ? `${m[3]}/${m[2]}` : ''; };
            const cls = s => String(s || '').toLowerCase().replace(/\s+/g, '-');
            const badge = s => `<span class="bd ${cls(s)}">${String(s || '').replace('IN TRANSIT', 'Transit')}</span>`;
            const meta = r => [r.reference, fmt(r.order_date)].filter(Boolean).join(' · ') || '&nbsp;';
            // Out (leaving Main) — ORDERED only = what still needs picking/sending.
            // IN TRANSIT already left; the full list (all statuses) stays in "all ›".
            const outEl = document.getElementById('whTrListOut');
            if (outEl) {
                const out = all.filter(r => r.from_location === MAIN_WH && String(r.status || '').toUpperCase() === 'ORDERED')
                    .sort((a, b) => String(b.order_date || '').localeCompare(a.order_date || '')).slice(0, 5);
                outEl.innerHTML = out.length ? out.map(r => {
                    const rj = JSON.stringify(r).replace(/'/g, '&#39;');
                    const ln = r.line_count != null ? `${r.line_count} line${r.line_count == 1 ? '' : 's'}` : '';
                    const live = r._live ? '<span class="live">live</span>' : '';
                    return `<div class="wh-tr-row" onclick='TOStaging.open(${rj})' title="Open pick sheet — edit & print"><span class="tn">${r.number || '—'}${live}</span><span class="to">${r.to_location || '—'}<span class="m">${meta(r)}</span></span><span class="ln">${ln}</span></div>`;
                }).join('') : '<div class="wh-tr-empty">Nothing to send.</div>';
            }
            // Incoming (arriving to Main) — informational
            const inEl = document.getElementById('whTrListIn');
            if (inEl) {
                const inb = all.filter(r => r.to_location === MAIN_WH && openS(r.status)).sort(sortF).slice(0, 5);
                inEl.innerHTML = inb.length ? inb.map(r => {
                    const rj = JSON.stringify(r).replace(/'/g, '&#39;');
                    return `<div class="wh-tr-row info" onclick='openTrLines(${rj})' title="See what is on the way"><span class="tn" style="color:#0f766e">${r.number || '—'}</span><span class="to">${r.from_location || '—'}<span class="m">${meta(r)}</span></span>${badge(r.status)}</div>`;
                }).join('') : '<div class="wh-tr-empty">Nothing incoming.</div>';
            }
        }

        // ── Find TR — one direct Cin7 lookup, no waiting on a webhook ──────────────
        // The Out list above is fed by cin7_mirror.order_pipeline, which only fills once
        // Cin7's webhook lands. A transfer created two minutes ago is simply not in it,
        // and until now that meant waiting to print. This asks Cin7 for that one transfer,
        // puts it in the list and opens the pick sheet. One call, one TR, nothing polled.
        function _normTr(v) {
            const digits = String(v || '').replace(/\D/g, '');
            return digits ? 'TR-' + digits : '';
        }
        async function findTR() {
            const inp = document.getElementById('whFindTr');
            const btn = document.getElementById('whFindBtn');
            const msg = document.getElementById('whFindMsg');
            const say = (t, cls) => { if (msg) { msg.textContent = t || ''; msg.className = 'ff-msg' + (cls ? ' ' + cls : ''); } };
            const num = _normTr(inp && inp.value);
            if (!num) { say('Type a TR number — e.g. TR-49952', 'err'); if (inp) inp.focus(); return; }
            if (btn) { btn.disabled = true; btn.textContent = 'Finding…'; }
            say('Asking Cin7 for ' + num + '…');
            try {
                const j = await (await fetch('/api/transfer-out/search?q=' + encodeURIComponent(num))).json();
                if (!j.success) throw new Error(j.error || 'lookup failed');
                const hit = (j.results || []).find(t => String(t.number || '').toUpperCase() === num);
                if (!hit) { say(num + ' not found in Cin7', 'err'); return; }

                // Put it where the rest of the board looks, so the row and the "all ›"
                // list show it too — not just the sheet we are about to open.
                // If the mirror already knows this TR its row is the richer one (line_count,
                // reference, date), so keep it and let the live values fill only the gaps.
                const data = window.__transferData || (window.__transferData = []);
                const at = data.findIndex(x => x.id === hit.id);
                const live = Object.fromEntries(Object.entries(hit).filter(([, v]) => v != null && v !== ''));
                const row = { ...(at >= 0 ? data[at] : { line_count: null }), ...live, type: 'TR', _live: true };
                if (at >= 0) data[at] = row; else data.unshift(row);
                if (typeof renderInlineTransfers === 'function') renderInlineTransfers(window.__whFocus);

                const focus = (window.__whFocus && window.__whFocus !== '__all__') ? window.__whFocus : 'Main Warehouse';
                say(hit.from_location === focus
                    ? num + ' loaded — opening the pick sheet'
                    : num + ' is out of ' + (hit.from_location || '?') + ', not ' + focus, hit.from_location === focus ? 'ok' : '');
                if (inp) inp.value = '';
                TOStaging.open(row);      // straight to the editable sheet, ready to print
            } catch (e) {
                say('Lookup failed: ' + e.message, 'err');
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = 'Find TR'; }
            }
        }

        // ── Coming In — what is actually inside an incoming transfer ───────────────
        // order_pipeline stores transfers header-only, so the items are fetched live from
        // Cin7 when a row is opened (server-side cached), rather than mirrored for a panel
        // that is read a few times a day.
        async function openTrLines(r) {
            const ov = document.getElementById('trLinesOverlay'); if (!ov) return;
            const set = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = t; };
            const fmt = d => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
            set('trlNo', r.number || '—');
            set('trlRoute', `${r.from_location || '—'}  →  ${r.to_location || '—'}${fmt(r.order_date) ? '  ·  ' + fmt(r.order_date) : ''}`);
            set('trlBadge', String(r.status || '').replace('IN TRANSIT', 'In transit'));
            set('trlSum', '');
            const body = document.getElementById('trlBody');
            if (body) body.innerHTML = '<div class="wh-tr-empty">Loading items from Cin7…</div>';
            ov.classList.add('active');
            _mountModalInFs('trLinesOverlay');
            document.body.style.overflow = 'hidden';
            try {
                const j = await (await fetch('/api/transfer/' + encodeURIComponent(r.id))).json();
                if (!j.success) throw new Error(j.error || 'detail failed');
                const lines = j.lines || [];
                if (!lines.length) {
                    if (body) body.innerHTML = '<div class="wh-tr-empty">This transfer has no items yet.</div>';
                    return;
                }
                const units = lines.reduce((s, l) => s + (Number(l.quantity) || 0), 0);
                set('trlSum', '');
                const sumEl = document.getElementById('trlSum');
                if (sumEl) sumEl.innerHTML = `<b>${lines.length}</b> line${lines.length !== 1 ? 's' : ''} · <b>${units}</b> unit${units !== 1 ? 's' : ''} on the way`;
                if (body) body.innerHTML = `<table class="trl-t">
                    <thead><tr><th>Code</th><th>Product</th><th style="text-align:right">Qty</th></tr></thead>
                    <tbody>${lines.map(l => `<tr>
                        <td class="c-sku">${_esc(l.sku)}</td>
                        <td>${_esc(l.product_name)}</td>
                        <td class="c-qty">${_esc(l.quantity)}</td>
                    </tr>`).join('')}</tbody></table>`;
            } catch (e) {
                if (body) body.innerHTML = `<div class="wh-tr-empty">Could not load items: ${_esc(e.message)}</div>`;
            }
        }
        function closeTrLines() {
            const ov = document.getElementById('trLinesOverlay'); if (!ov) return;
            ov.classList.remove('active');
            _restoreModal('trLinesOverlay');
            document.body.style.overflow = '';
        }
        function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

        function openTransfersModal(direction) {
            if (direction === 'outbound' || direction === 'inbound') {
                _trDirectionFilter = direction;
                document.querySelectorAll('.tr-direction-btn[data-dir]').forEach(b => {
                    b.classList.toggle('active', b.dataset.dir === direction);
                });
            }
            document.getElementById('trModalOverlay').classList.add('active');
            _mountModalInFs('trModalOverlay');
            document.body.style.overflow = 'hidden';
            renderTransfersTable();
        }
        function closeTransfersModal() {
            document.getElementById('trModalOverlay').classList.remove('active');
            _restoreModal('trModalOverlay');
            document.body.style.overflow = '';
        }
        function setTrDirection(btn) {
            document.querySelectorAll('.tr-direction-btn[data-dir]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _trDirectionFilter = btn.dataset.dir;
            renderTransfersTable();
        }
        function setTrStatus(btn) {
            document.querySelectorAll('.tr-direction-btn[data-status]').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _trStatusFilter = btn.dataset.status;
            renderTransfersTable();
        }
        function renderTransfersTable() {
            const MAIN_WH = 'Main Warehouse';
            const data = window.__transferData || [];
            const search = (document.getElementById('trSearch')?.value || '').toLowerCase();

            const CLOSED_TR = ['COMPLETED', 'VOIDED', 'CANCELLED', 'CLOSED', 'INVOICED'];
            let rows = data.filter(r => {
                // Hide finished transfers — only open ones (ORDERED / IN TRANSIT) matter here
                if (CLOSED_TR.includes(String(r.status || '').toUpperCase())) return false;
                // Direction filter
                if (_trDirectionFilter === 'outbound' && r.from_location !== MAIN_WH) return false;
                if (_trDirectionFilter === 'inbound' && r.to_location !== MAIN_WH) return false;
                // Status filter
                if (_trStatusFilter !== 'all' && r.status !== _trStatusFilter) return false;
                // Search
                if (search) {
                    const hay = `${r.number} ${r.from_location||''} ${r.to_location||''} ${r.status} ${r.reference||''}`.toLowerCase();
                    if (!hay.includes(search)) return false;
                }
                return true;
            });

            // Sort: IN TRANSIT first, then ORDERED, then by date desc
            const statusOrder = { 'IN TRANSIT': 0, 'ORDERED': 1 };
            rows.sort((a, b) => {
                const sa = statusOrder[a.status] ?? 9;
                const sb = statusOrder[b.status] ?? 9;
                if (sa !== sb) return sa - sb;
                return (b.order_date || '').localeCompare(a.order_date || '');
            });

            const tbody = document.getElementById('trTableBody');
            const empty = document.getElementById('trEmpty');
            const countEl = document.getElementById('trCount');
            if (countEl) countEl.textContent = rows.length + ' transfer' + (rows.length !== 1 ? 's' : '');

            if (rows.length === 0) {
                tbody.innerHTML = '';
                empty.style.display = '';
                return;
            }
            empty.style.display = 'none';

            const fmtDate = d => { if (!d) return '—'; const [y,m,dd] = d.split('-'); return `${dd}/${m}`; };
            const statusClass = s => (s || '').toLowerCase().replace(/\s+/g, '-');

            tbody.innerHTML = rows.map(r => {
                const isOutbound = r.from_location === MAIN_WH;
                const rj = JSON.stringify(r).replace(/'/g, "&#39;");
                // Outbound rows open the editable pick sheet (staging → print). Inbound just listed.
                const openAttr = isOutbound ? ` style="cursor:pointer" title="Open pick sheet — edit & print" onclick='TOStaging.open(${rj})'` : '';
                return `<tr${openAttr}>
                    <td class="tr-num">${r.number || '—'}</td>
                    <td class="tr-route"><span class="tr-from">${r.from_location || '?'}</span><span class="tr-arrow">→</span><span class="tr-to">${r.to_location || '?'}</span></td>
                    <td><span class="tr-badge ${statusClass(r.status)}">${r.status || '—'}</span></td>
                    <td class="tr-date">${fmtDate(r.order_date)}</td>
                    <td class="tr-ref" title="${r.reference || ''}">${r.reference || '—'}</td>
                </tr>`;
            }).join('');
        }

// ══════════════════════════════════════════════════════
// QUALITY & COMPLIANCE GATE
// ══════════════════════════════════════════════════════
// The whole section sits behind the PIN now, not four of its seven items: it carries
// per-operator productivity and anomaly review, which is exactly the part people ask
// not to be browsed casually.
//
// Worth being plain about what this is: 4209 is shared by the team and lives in this
// file, which anyone can read. It stops a wrong click and signals "not for everyone".
// It is not authentication, and nothing that needs authentication should hide behind it.
function qcAskPin() {
    const row = document.getElementById('qcPinRow');
    if (!row) return;
    const wasOpen = !row.hidden;
    row.hidden = wasOpen;
    if (!wasOpen) {
        const i = document.getElementById('qcPin');
        if (i) { i.value = ''; i.placeholder = 'PIN'; i.classList.remove('bad'); i.focus(); }
    }
}

function qcUnlock() {
    const i = document.getElementById('qcPin');
    if (!i) return;
    if (i.value.trim() !== '4209') { i.classList.add('bad'); i.value = ''; i.placeholder = 'Wrong'; return; }
    qcReveal();
    // Survives walking into a gated page and coming back. Without it the PIN gets typed
    // a dozen times a shift, which is how a PIN turns into something people write on a
    // sticky note. sessionStorage, not localStorage: it dies with the tab instead of
    // leaving a shared warehouse PC unlocked forever.
    try { sessionStorage.setItem('qcUnlocked', '1'); } catch (_) {}
}

function qcReveal() {
    const g = document.getElementById('qcGated'); if (g) g.hidden = false;
    const r = document.getElementById('qcPinRow'); if (r) r.hidden = true;
    const b = document.getElementById('qcLockBtn'); if (b) b.remove();
}

// Runs inline: home.js loads at the end of the body, so the sidebar is already parsed.
try { if (sessionStorage.getItem('qcUnlocked') === '1') qcReveal(); } catch (_) {}
