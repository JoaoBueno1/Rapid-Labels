"""One function per report: mirror rows in, tidy long-format rows out.

Deliberately concrete rather than a generic SQL layer. What each report counts
was settled by reconciling against real Cin7 exports (docs/EXCEL_SYNC_REPORTS.md);
that reasoning belongs in named, commented code, not in a query string a spec
file happens to carry.

Every function returns (rows, meta) where rows are dicts with at least
`sku`, `location`, plus the metric columns the spec asks for.
"""
import calendar
import datetime as _dt

from . import supabase

# Statuses the Cin7 "Sale Order Details" report does not count. Proved on
# 2026-08-07 against an export taken ~1 min after a catch-up sync: with this
# set, 1,628 of 1,630 cells match exactly (qty 100.02%, value 100.01%) and no
# export cell is left without a mirror pair. Dropping any one of these, or
# adding BACKORDERED, makes it strictly worse — see EXCEL_SYNC_REPORTS.md.
SALES_EXCLUDED_STATUS = ('VOIDED', 'CANCELLED', 'ESTIMATING', 'ESTIMATED',
                         'ORDERING', 'DRAFT')

# The stock report only lists inventory products. Verified exactly: all 19
# mirror-only SKUs are type='Non Inventory' (Freight, Paint, EC-SCREWS, ...)
# and every sampled included SKU is 'Stock'. It is NOT a zero-quantity filter —
# Paint|Main Warehouse holds 157 units and is still absent from the export.
STOCK_PRODUCT_TYPE = 'Stock'


def _num(v):
    return 0.0 if v in (None, '') else float(v)


def month_bounds(month):
    """'YYYY-MM' -> ('YYYY-MM-01', 'YYYY-MM-<last>')."""
    y, m = (int(x) for x in month.split('-'))
    return f'{month}-01', f'{month}-{calendar.monthrange(y, m)[1]:02d}'


def current_month():
    """Business timezone, not UTC — the scheduled run fires at 19:00 UTC, which
    is already the next day in Sydney, so a UTC month flips a day early."""
    try:
        from zoneinfo import ZoneInfo
        now = _dt.datetime.now(ZoneInfo('Australia/Sydney'))
    except Exception:
        now = _dt.datetime.now()
    return now.strftime('%Y-%m')


# ─────────────────────────────────────────────────────────────────────────────

def _newest(rows, col):
    """The most recent timestamp in `col`, as an ISO string, or None.

    Compared as text on purpose: PostgREST returns ISO-8601 UTC, which sorts
    correctly as a string, and parsing thousands of rows to find one maximum
    would be work for nothing.
    """
    best = None
    for r in rows:
        v = r.get(col)
        if v and (best is None or v > best):
            best = v
    return best


def stock_level(sb=None, **_):
    """Cin7 "Inventory Products Stock Level Report" — SKU x warehouse.

    stock_snapshot is per bin; the report is per warehouse, so everything is
    summed up to (sku, location).
    """
    sb = sb or supabase.Client()
    snap = sb.select(
        'stock_snapshot',
        'sku,location_name,on_hand,allocated,available,on_order,in_transit,stock_on_hand,synced_at')
    prods = sb.select('products', 'sku,uom,type,average_cost')

    keep = {}
    for p in prods:
        if (p.get('type') or '').strip() == STOCK_PRODUCT_TYPE:
            keep[(p['sku'] or '').strip()] = p

    agg = {}
    for r in snap:
        sku = (r['sku'] or '').strip()      # the mirror holds two SKUs with a
        if sku not in keep:                 # trailing space; Cin7 trims them
            continue
        key = (sku, r['location_name'])
        a = agg.get(key)
        if a is None:
            a = agg[key] = {'sku': sku, 'location': r['location_name'],
                            'unit': keep[sku].get('uom') or 'Item',
                            'on_hand': 0.0, 'allocated': 0.0, 'available': 0.0,
                            'on_order': 0.0, 'in_transit': 0.0, 'stock_value': 0.0}
        a['on_hand'] += _num(r['on_hand'])
        a['allocated'] += _num(r['allocated'])
        # `available` is copied, never recomputed: Cin7 derives carton-SKU
        # availability from the loose parent stock, so on 1,666 of 14,971 rows
        # available != on_hand - allocated. The export shows the same 1,666.
        a['available'] += _num(r['available'])
        a['on_order'] += _num(r['on_order'])
        a['in_transit'] += _num(r['in_transit'])
        # stock_on_hand is the AUD VALUE, not a quantity. Confirmed against the
        # export, where Unit cost and Stock on hand are separate columns and
        # on_hand * unit_cost == stock_on_hand on 9,877 of 9,877 blocks.
        a['stock_value'] += _num(r['stock_on_hand'])

    rows = []
    for a in agg.values():
        # Cin7 prints 0, not the product's average cost, when a block holds no
        # stock — an on-order-only row shows Unit cost 0. Falling back to
        # products.average_cost inflated the column ~2.7x on 2,533 blocks.
        a['unit_cost'] = (a['stock_value'] / a['on_hand']) if a['on_hand'] else 0.0
        rows.append(a)
    # How old the DATA is, not how long ago we built. A frozen mirror still
    # produces a brand-new built_at, so gating on our own build time cannot
    # tell 'refreshed this morning' from 'the Cin7 sync died on Friday and we
    # have been republishing the same numbers ever since'. This is the one
    # figure that can.
    meta = {'source_rows': len(snap), 'products': len(prods), 'stock_products': len(keep),
            'cells': len(rows), 'calls': sb.calls,
            'data_at': _newest(snap, 'synced_at')}
    return rows, meta


# ─────────────────────────────────────────────────────────────────────────────
def monthly_sales(sb=None, month=None, **_):
    """Cin7 "Sale Order Details" — SKU x warehouse for one month.

    Period is `order_date` (tested against invoice_date, +16%, and ship_date,
    +70%). The warehouse comes from the ORDER HEADER (`location_name`), not the
    line — sale_lines carries no location.
    """
    sb = sb or supabase.Client()
    month = month or current_month()
    start, end = month_bounds(month)

    orders = sb.select(
        'sales_orders', 'order_number,order_date,status,location_name,detail_synced_at,header_synced_at',
        filters=[('order_date', f'gte.{start}'), ('order_date', f'lte.{end}')])

    counted = {o['order_number']: o['location_name'] for o in orders
               if o['status'] not in SALES_EXCLUDED_STATUS and o['location_name']}
    # Coverage is measured over every order the report would count, including
    # any still missing its detail — that is exactly what the gate must see.
    scoped = [o for o in orders if o['status'] not in SALES_EXCLUDED_STATUS]
    detailed = [o for o in scoped if o['detail_synced_at']]

    lines = sb.select_in('sale_lines', 'order_number,sku,quantity,total,tax',
                         'order_number', counted.keys()) if counted else []

    agg = {}
    for ln in lines:
        loc = counted.get(ln['order_number'])
        if not loc:
            continue
        key = ((ln['sku'] or '').strip(), loc)
        a = agg.get(key)
        if a is None:
            a = agg[key] = {'sku': key[0], 'location': loc, 'quantity': 0.0, 'total': 0.0}
        a['quantity'] += _num(ln['quantity'])
        # The export's Total is GST-INCLUSIVE. sale_lines.total is ex-GST:
        # summing it alone gives exactly 1/1.1 of the export. total + tax
        # matched 1,470 of 1,471 qty-identical cells. Do NOT use * 1.1 — that
        # would break on any tax-exempt line.
        a['total'] += _num(ln['total']) + _num(ln['tax'])

    # Newest sync stamp across the orders in scope — see _newest and the note
    # on stock_level's data_at. detail_synced_at is used as a fallback because
    # an order re-fetched for its lines is evidence of a live sync too.
    data_at = _newest(orders, 'header_synced_at') or _newest(orders, 'detail_synced_at')
    meta = {'month': month, 'period': f'{start}..{end}', 'data_at': data_at,
            'orders_in_window': len(orders), 'orders_counted': len(scoped),
            'orders_with_detail': len(detailed),
            'detail_coverage_pct': (100.0 * len(detailed) / len(scoped)) if scoped else 100.0,
            'lines': len(lines), 'cells': len(agg), 'calls': sb.calls}
    return list(agg.values()), meta


SOURCES = {'stock_level': stock_level, 'monthly_sales': monthly_sales}
