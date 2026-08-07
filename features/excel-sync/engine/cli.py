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

from . import pivot, sources, verify


def _fmt(v):
    return f'{round(v):,}'.replace(',', ' ') if isinstance(v, (int, float)) else str(v)


def cmd_list(_):
    for slug in pivot.list_specs():
        spec = pivot.load_spec(slug)
        wb = spec.get('workbook', {})
        print(f"  {slug:<16} {spec.get('title', '')}")
        print(f"                   source={spec['source']}  →  {wb.get('file', 'TBD')} / {wb.get('sheet', 'TBD')}")
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

    if not ok:
        print('\n  BLOCKED — not fit to publish')
        return 1
    print('\n  OK')
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(prog='excel-sync')
    sub = p.add_subparsers(dest='cmd', required=True)
    sub.add_parser('list', help='show the report specs').set_defaults(fn=cmd_list)

    b = sub.add_parser('build', help='build a report from the mirror')
    b.add_argument('slug')
    b.add_argument('--month', help='YYYY-MM (defaults to the current Sydney month)')
    b.add_argument('--out', help='directory to write csv/xlsx into')
    b.add_argument('--verify', help='Cin7 export to diff against')
    b.add_argument('--show', type=int, default=8, help='how many differing cells to print')
    b.add_argument('--tolerance', type=float, default=1.0, help='max %% off the export')
    b.set_defaults(fn=cmd_build)

    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == '__main__':
    sys.exit(main())
