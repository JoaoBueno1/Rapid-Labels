"""excel-sync CLI.

    python -m engine list
    python -m engine build monthly-sales [--month 2026-08] [--out DIR]
    python -m engine build monthly-sales --verify "~/Downloads/Sale Order Details (23).xlsx"

`--verify` is the point of phase 1: build the tab from the mirror and diff it,
cell by cell, against the Cin7 export it is meant to replace. Nothing writes to
a real workbook until that diff is clean — Microsoft Graph is a later phase and
a swappable adapter, not part of this path.
"""
import argparse
import os
import sys

from . import flat, pivot, sources, verify


def _fmt(v):
    return f'{round(v):,}'.replace(',', ' ') if isinstance(v, (int, float)) else str(v)


def cmd_list(_):
    print('datasets (built once, stored in excel_sync.dataset_rows):')
    for slug in pivot.list_specs():
        spec = pivot.load_spec(slug)
        cols = ', '.join(m['header'] for m in spec['metrics'])
        print(f"  {slug:<16} {spec.get('title', '')}")
        print(f"  {'':<16} source={spec['source']}  columns: {cols}")
    bindings = pivot.list_bindings()
    print(f'\nbindings (workbook tabs consuming them): {len(bindings) or "none yet"}')
    for slug in bindings:
        b = pivot.load_binding(slug)
        wb = b['workbook']
        state = 'enabled' if b.get('enabled') else 'disabled'
        print(f"  {slug:<16} {b['dataset']} → {wb.get('file')} / {wb.get('sheet')}  [{state}]")
    if not bindings:
        print('  add one: see specs/bindings/README.md')
    return 0


def cmd_register(_):
    """Mirror datasets and bindings into ops.sync_registry so the monitor lists them."""
    from . import publish
    specs = [pivot.load_spec(s) for s in pivot.list_specs()]
    publish.register_datasets(specs)
    print(f'  registered {len(specs)} dataset build(s)')
    for s in specs:
        print(f"    excel-dataset-{s['slug']}")

    bindings = [pivot.load_binding(s) for s in pivot.list_bindings()]
    if bindings:
        publish.register_bindings(bindings)
        print(f'  registered {len(bindings)} workbook binding(s)')
        for b in bindings:
            print(f"    excel-{b['slug']:<20} {b['dataset']} → {b['workbook'].get('file')}")
    else:
        print('  no workbook bindings yet — see specs/bindings/README.md')
    return 0


def cmd_build(args):
    spec = pivot.load_spec(args.slug)
    fn = sources.SOURCES.get(spec['source'])
    if fn is None:
        raise SystemExit(f"spec references unknown source '{spec['source']}'")

    print(f"▶ {args.slug} — {spec.get('title', '')}")
    rows, meta = fn(month=args.month)
    built = pivot.build(rows, spec)
    print(f"  source .......... {meta.get('cells')} cells, {meta.get('calls')} Supabase calls")
    if 'period' in meta:
        print(f"  period .......... {meta['period']}")
    print(f"  pivot ........... {len(built['keys'])} rows x {len(built['groups'])} warehouses")

    ok, checks = verify.check(meta, spec, built)
    print('  gates:')
    for level, msg in checks:
        mark = {'ok': '✓', 'warn': '!', 'block': '✗'}[level]
        print(f'    {mark} {msg}')

    if args.verify:
        path = os.path.expanduser(args.verify)
        if not os.path.exists(path):
            raise SystemExit(f'export not found: {path}')
        export = verify.read_cin7_export(path, spec.get('workbook', {}).get('source_sheet'))
        d = verify.diff(built, spec, export)
        print(f"\n  ── diff vs {os.path.basename(path)}")
        if export['meta']:
            print('     export says:', ' | '.join(f'{k}: {v}' for k, v in export['meta'].items()))
        print(f"     cells  export {d['export_cells']}   mirror {d['mirror_cells']}   "
              f"in both {d['both']}   only-export {len(d['only_export'])}   only-mirror {len(d['only_mirror'])}")
        # Tolerance is per metric: Quantity and Total fail for different reasons
        # and at different thresholds, so one global number would either hide a
        # money error or block on a known quantity quirk.
        by_header = {m['header']: m for m in spec['metrics']}
        failed = []
        for name, r in d['metrics'].items():
            pct = 100.0 * r['same'] / r['both'] if r['both'] else 0.0
            off = abs(100.0 - r['pct'])
            tol = by_header[name].get('total_tolerance_pct', args.tolerance)
            mark = '✓' if off <= tol else '✗'
            if off > tol:
                failed.append((name, off, tol))
            print(f"     {mark} {name:<16} identical {r['same']}/{r['both']} ({pct:.2f}%)   "
                  f"total {_fmt(r['total_mirror'])} vs {_fmt(r['total_export'])} = {r['pct']:.2f}%  (tol ±{tol}%)")
            for (k, g), e, o, delta in r['diffs'][:args.show]:
                print(f"        {k} | {g}: export={_fmt(e)} mirror={_fmt(o)} Δ={'+' if delta > 0 else ''}{_fmt(delta)}")
        for c in d['only_export'][:args.show]:
            print(f"     only in export: {c[0]} | {c[1]}")
        for c in d['only_mirror'][:args.show]:
            print(f"     only in mirror: {c[0]} | {c[1]}")
        if failed:
            for name, off, tol in failed:
                print(f'\n  ✗ {name} off by {off:.2f}% — above its {tol}% tolerance')
            ok = False
        else:
            print('\n  ✓ every metric within tolerance of the Cin7 export')

    if args.out:
        os.makedirs(args.out, exist_ok=True)
        stem = args.slug + (f"-{meta['month']}" if meta.get('month') else '')
        csv_path = pivot.write_csv(built, spec, meta, os.path.join(args.out, stem + '.csv'))
        print(f'\n  wrote {csv_path}')
        xl = pivot.write_xlsx(built, spec, meta, os.path.join(args.out, stem + '.xlsx'))
        print(f'  wrote {xl}' if xl else '  (openpyxl missing — csv only)')

    if args.publish:
        from . import publish as pub
        with pub.Run('excel-dataset-' + args.slug) as run:
            if not ok and not args.force:
                run.finish('blocked', 'validation gates failed')
                print('\n  BLOCKED — nothing published')
                return 1
            digest, changed, written = pub.publish_dataset(spec, rows, meta, built)
            run.rows_written = len(rows)
            run.stats = {'checksum': digest, 'changed': changed,
                         'groups': len(built['groups']), 'keys': len(built['keys'])}
            run.finish('success')
        print(f"\n  published {len(rows)} rows to excel_sync.dataset_rows"
              f"  checksum={digest[:12]}  {'CHANGED' if changed else 'unchanged since last build'}")

    if not ok:
        print('\n  BLOCKED — not fit to publish')
        return 1
    print('\n  OK')
    return 0


def cmd_render(args):
    """Build the exact block a workbook tab will receive, and diff it against the
    tab as it stands today. This is the binding-level equivalent of `--verify`:
    proof before anything is ever written through Graph."""
    binding = pivot.load_binding(args.slug)
    lay = binding['layout']
    print(f"▶ {args.slug} — {binding.get('title','')}")
    print(f"  {binding['dataset']}  →  {binding['workbook']['file']} / {binding['workbook']['sheet']}")
    print(f"  locations: {', '.join(lay['locations'])}"
          + ("  (SUMMED)" if len(lay['locations']) > 1 else ""))

    rows = flat.fetch_dataset(binding['dataset'])
    built = flat.build(rows, binding)
    rng = flat.a1(lay['data_anchor'], len(built['grid']), len(built['cols']))
    print(f"  block ......... {len(built['grid'])} rows x {len(built['cols'])} cols  →  {rng}")
    if built['missing_locations']:
        print(f"  ! locations with no rows in the dataset: {built['missing_locations']}")

    if args.workbook:
        import openpyxl
        wb = openpyxl.load_workbook(os.path.expanduser(args.workbook), data_only=True)
        sheet = binding['workbook']['sheet']
        if sheet not in wb.sheetnames:
            raise SystemExit(f"workbook has no sheet {sheet!r}")
        ws = wb[sheet]
        import re
        m = re.match(r'^([A-Z]+)(\d+)$', lay['data_anchor'].upper())
        c0 = 0
        for ch in m.group(1):
            c0 = c0 * 26 + (ord(ch) - 64)
        r0 = int(m.group(2))
        cur = {}
        r = r0
        while r <= ws.max_row:
            k = ws.cell(r, c0).value
            if k in (None, ''):
                break
            cur[str(k).strip()] = [ws.cell(r, c0 + i).value for i in range(1, len(built['cols']))]
            r += 1
        print(f"\n  ── tab today: {len(cur)} rows   vs   ours: {len(built['grid'])}")
        ours = {row[0]: row[1:] for row in built['grid']}
        both = [k for k in cur if k in ours]
        print(f"     SKUs in both {len(both)} | only in tab {len(set(cur) - set(ours))}"
              f" | only in ours {len(set(ours) - set(cur))}")
        # compare the column every formula actually reads
        idx = next((i for i, c in enumerate(built['cols'][1:])
                    if c['field'] in ('available', 'quantity')), None)
        if idx is not None and both:
            name = built['cols'][idx + 1]['header']
            same = 0
            diffs = []
            for k in both:
                a = cur[k][idx]
                b = ours[k][idx]
                a = 0 if a in (None, '') else float(a)
                b = 0 if b in (None, '') else float(b)
                if abs(a - b) < 0.005:
                    same += 1
                else:
                    diffs.append((k, a, b))
            print(f"     '{name}' identical on {same}/{len(both)} ({100*same/len(both):.1f}%)"
                  f"  — the column the VLOOKUPs read")
            diffs.sort(key=lambda d: -abs(d[2] - d[1]))
            for k, a, b in diffs[:args.show]:
                print(f"        {k:<28} tab={a:>10.0f}  ours={b:>10.0f}  Δ={b-a:+.0f}")

    if args.out:
        os.makedirs(args.out, exist_ok=True)
        import csv
        path = os.path.join(args.out, args.slug + '.csv')
        with open(path, 'w', newline='', encoding='utf-8') as fh:
            w = csv.writer(fh)
            w.writerow([c['header'] for c in built['cols']])
            w.writerows(built['grid'])
        print(f"\n  wrote {path}")
    return 0


def cmd_apply(args):
    """Build every binding for a workbook and write them in one pass."""
    from .delivery import local_xlsx
    path = os.path.expanduser(args.workbook)
    if not os.path.exists(path):
        raise SystemExit(f'not found: {path}')

    parts = local_xlsx.inspect_parts(path)
    print(f"▶ {os.path.basename(path)}")
    print(f"  parts: {parts['total']}  drawings={len(parts['drawings'])} "
          f"media={len(parts['media'])} customXml={len(parts['customXml'])}"
          + ("   ← these are LOST on write" if (parts['drawings'] or parts['media']) else ""))
    if local_xlsx.is_synced_path(path):
        print("  ⚠ this path is CLOUD-SYNCED — writing it publishes to everyone")

    jobs = []
    for slug in args.bindings:
        binding = pivot.load_binding(slug)
        lay = binding['layout']
        rows = flat.fetch_dataset(binding['dataset'])
        built = flat.build(rows, binding)
        rng = flat.a1(lay['data_anchor'], len(built['grid']), len(built['cols']))
        print(f"  {slug:<18} {binding['workbook']['sheet']:<11} {len(built['grid']):>5} rows → {rng}"
              + ("  (SUMMED)" if len(lay['locations']) > 1 else ""))
        jobs.append({
            'sheet': binding['workbook']['sheet'],
            'anchor': lay['data_anchor'],
            'grid': built['grid'],
            'status_cell': binding.get('status', {}).get('cell'),
            'status_text': local_xlsx.status_text(rows=len(built['grid'])),
        })

    rep = local_xlsx.write_blocks(
        path, jobs, backup_dir=args.backup_dir,
        allow_synced=args.i_know_this_is_live, dry_run=args.dry_run)

    print(f"\n  {'would write' if args.dry_run else 'wrote'}:")
    for s in rep['sheets']:
        note = f"  cleared {s['rows_cleared']} leftover rows" if s['rows_cleared'] else ""
        print(f"    {s['sheet']:<11} {s['rows']} rows at {s['anchor']} "
              f"(last row {s['prev_last_row']} → {s['new_last_row']}){note}")
        if s['status_cell']:
            print(f"    {'':11} status → {s['status_cell']}")
    if rep['backup']:
        print(f"  backup: {rep['backup']}")
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(prog='excel-sync')
    sub = p.add_subparsers(dest='cmd', required=True)
    sub.add_parser('list', help='show datasets and the workbook bindings').set_defaults(fn=cmd_list)
    sub.add_parser('register', help='mirror bindings into ops.sync_registry').set_defaults(fn=cmd_register)

    b = sub.add_parser('build', help='build a dataset from the mirror')
    b.add_argument('slug')
    b.add_argument('--month', help='YYYY-MM (defaults to the current Sydney month)')
    b.add_argument('--out', help='directory to write csv/xlsx into')
    b.add_argument('--verify', help='Cin7 export to diff against')
    b.add_argument('--publish', action='store_true',
                   help='store the dataset in Supabase for the workbooks to read')
    b.add_argument('--force', action='store_true',
                   help='publish even if a gate failed (records the run as blocked)')
    b.add_argument('--show', type=int, default=8, help='how many differing cells to print')
    b.add_argument('--tolerance', type=float, default=1.0, help='max %% off the export')
    b.set_defaults(fn=cmd_build)

    r = sub.add_parser('render', help='build a workbook tab block and diff it against the tab')
    r.add_argument('slug')
    r.add_argument('--workbook', help='path to the .xlsx to diff against')
    r.add_argument('--out', help='directory to write the block as csv')
    r.add_argument('--show', type=int, default=8)
    r.set_defaults(fn=cmd_render)

    a = sub.add_parser('apply', help='write the blocks into a workbook on disk')
    a.add_argument('workbook', help='path to the .xlsx to write')
    a.add_argument('--bindings', nargs='+', required=True, help='binding slugs to apply')
    a.add_argument('--backup-dir', default='out/backups')
    a.add_argument('--dry-run', action='store_true')
    a.add_argument('--i-know-this-is-live', action='store_true',
                   help='required to write inside a cloud-synced folder')
    a.set_defaults(fn=cmd_apply)

    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == '__main__':
    sys.exit(main())
