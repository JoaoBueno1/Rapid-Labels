"""Flat layout — the shape the branch workbooks actually use.

The datasets are SKU x warehouse (wide). The workbook tabs are SKU x a few
metrics for ONE branch — or, in the case of a `SOH Main` tab, for Main Warehouse
and Gateway SUMMED, which is how the order templates want to see them. So a
binding filters the dataset to a set of locations and, when there is more than
one, adds them together.

Nothing is recomputed from the mirror here: this reads the already-published
dataset, so every workbook sees exactly the same snapshot.
"""
from . import supabase


def _num(v):
    return 0.0 if v in (None, '') else float(v)


# Only additive metrics may be summed across locations. unit_cost is a ratio —
# adding Main's to Gateway's would be meaningless, so it is refused rather than
# silently producing a number that looks plausible.
NON_ADDITIVE = {'unit_cost'}


def fetch_dataset(slug, sb=None):
    """Read a published dataset back out of Supabase (paged)."""
    sb = sb or supabase.Client(schema='public')
    out = []
    offset = 0
    while True:
        rows = sb.rpc_range('excel_dataset_rows', {'p_dataset': slug}, offset, 1000)
        out.extend(rows)
        if len(rows) < 1000:
            return out
        offset += 1000


def build(rows, binding):
    """Dataset rows -> {keys, grid, locations, dropped} for one workbook tab."""
    lay = binding['layout']
    locs = lay.get('locations') or []
    cols = binding['columns']
    key_field = lay.get('key', 'sku')

    for c in cols:
        if len(locs) > 1 and c['field'] in NON_ADDITIVE:
            raise SystemExit(
                f"binding '{binding['slug']}' sums {len(locs)} locations but asks for "
                f"'{c['field']}', which is a ratio and cannot be added across them")

    wanted = set(locs)
    acc = {}
    seen_locs = set()
    for r in rows:
        loc = r['location']
        if wanted and loc not in wanted:
            continue
        seen_locs.add(loc)
        sku = r[key_field] if key_field in r else r['sku']
        a = acc.get(sku)
        if a is None:
            a = acc[sku] = {'sku': sku}
        m = r.get('metrics') or {}
        for c in cols:
            f = c['field']
            if f == key_field or f == 'sku':
                continue
            if f in m:
                a[f] = a.get(f, 0.0) + _num(m[f])

    # Cin7 sorts case-insensitively and the tabs were pasted from it; match that
    # so a human diffing old against new sees rows line up.
    keys = sorted(acc, key=lambda s: (str(s).lower(), str(s)))

    grid = []
    for k in keys:
        row = []
        for c in cols:
            if c.get('blank'):
                row.append('')                     # e.g. the Discount column
                continue
            v = acc[k].get(c['field'], '' if c['field'] == 'sku' else 0)
            if c['field'] == 'sku':
                v = k
            elif isinstance(v, float):
                nd = c.get('round')
                v = round(v, nd) if nd is not None else (int(v) if v == int(v) else v)
            row.append(v)
        grid.append(row)

    missing = sorted(wanted - seen_locs)
    return {'keys': keys, 'grid': grid, 'locations': sorted(seen_locs),
            'missing_locations': missing, 'cols': cols}


def a1(anchor, n_rows, n_cols):
    """'B3' + 2933x5 -> 'B3:F2935'."""
    import re
    m = re.match(r'^([A-Z]+)(\d+)$', anchor.upper())
    if not m:
        raise SystemExit(f'bad anchor {anchor!r} — expected something like B3')
    col, row = m.group(1), int(m.group(2))
    ci = 0
    for ch in col:
        ci = ci * 26 + (ord(ch) - 64)
    end_ci = ci + n_cols - 1
    s = ''
    while end_ci:
        end_ci, rem = divmod(end_ci - 1, 26)
        s = chr(65 + rem) + s
    return f'{col}{row}:{s}{row + n_rows - 1}'
