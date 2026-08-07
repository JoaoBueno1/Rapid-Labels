"""Materialise a dataset into Supabase, and log the run.

Why materialise instead of letting each workbook rebuild: several spreadsheets
want the same numbers. Rebuilding per workbook would re-read the mirror N times
AND let two tabs refreshed minutes apart disagree with each other. Built once,
stored once, every binding reads the same snapshot.
"""
import hashlib
import json
import os
import time

from . import supabase

OPS = 'ops'
XS = 'excel_sync'


def checksum(rows, metrics):
    """Stable digest of the values that reach Excel. Lets the monitor say
    'ran, nothing changed' — the difference between healthy and quietly stuck."""
    h = hashlib.sha256()
    for r in sorted(rows, key=lambda r: (str(r['sku']).lower(), str(r['location']))):
        h.update(str(r['sku']).encode())
        h.update(b'\x00')
        h.update(str(r['location']).encode())
        for m in metrics:
            v = r.get(m['field'])
            h.update(b'\x00')
            h.update(b'' if v is None else format(float(v), '.6f').encode())
    return h.hexdigest()[:32]


def publish_dataset(spec, rows, meta, built, sb=None):
    """Replace the dataset in one atomic call. Returns (checksum, changed)."""
    sb = sb or supabase.Client(schema=XS)
    metrics = spec['metrics']
    digest = checksum(rows, metrics)

    prev = sb.select('datasets', 'slug,checksum', filters=[('slug', f'eq.{spec["slug"]}')])
    changed = not prev or prev[0].get('checksum') != digest

    payload = [{'sku': r['sku'], 'location': r['location'],
                'metrics': {m['field']: r.get(m['field']) for m in metrics}}
               for r in rows]

    written = sb.rpc('replace_dataset', {
        'p_slug': spec['slug'],
        'p_title': spec.get('title', spec['slug']),
        'p_grain': 'sku x location',
        'p_period': meta.get('period'),
        'p_columns': [{'header': m['header'], 'field': m['field']} for m in metrics],
        'p_meta': {k: v for k, v in meta.items() if not isinstance(v, (list, dict))},
        'p_checksum': digest,
        'p_rows': payload,
    })
    return digest, changed, written


# ─────────────────────────────────────────────────────────────────────────────
class Run:
    """Context manager that logs one run to ops.sync_runs.

    Always closes the row — a job that dies mid-write must not leave a 'running'
    record that the monitor would show forever as in-progress.
    """

    def __init__(self, slug, trigger=None, sb=None):
        self.slug = slug
        self.sb = sb or supabase.Client(schema=OPS)
        self.trigger = trigger or ('cron' if os.environ.get('GITHUB_ACTIONS') else 'manual')
        self.run_id = None
        self.stats = {}
        self.rows_written = None
        self.t0 = None

    def __enter__(self):
        self.t0 = time.time()
        run_url = None
        if os.environ.get('GITHUB_ACTIONS'):
            srv = os.environ.get('GITHUB_SERVER_URL', 'https://github.com')
            repo = os.environ.get('GITHUB_REPOSITORY', '')
            rid = os.environ.get('GITHUB_RUN_ID', '')
            run_url = f'{srv}/{repo}/actions/runs/{rid}' if repo and rid else None
        try:
            got = self.sb.insert('sync_runs', [{
                'slug': self.slug, 'status': 'running',
                'trigger': self.trigger, 'run_url': run_url}])
            self.run_id = got[0]['run_id'] if got else None
        except SystemExit as e:
            # Run logging must never be the reason a sync fails.
            print(f'  ! could not open run log: {e}')
        return self

    def finish(self, status, error=None):
        if self.run_id is None:
            return
        try:
            self.sb.patch('sync_runs', [('run_id', f'eq.{self.run_id}')], {
                'status': status,
                'ended_at': 'now()',
                'duration_ms': int((time.time() - self.t0) * 1000),
                'rows_written': self.rows_written,
                'error': (error or '')[:2000] or None,
                'stats': self.stats,
            })
        except SystemExit as e:
            print(f'  ! could not close run log: {e}')

    def __exit__(self, exc_type, exc, tb):
        if exc is not None:
            self.finish('failed', f'{exc_type.__name__}: {exc}')
        return False   # never swallow


# ─────────────────────────────────────────────────────────────────────────────
def register_bindings(bindings, sb=None):
    """Mirror the binding TOMLs into ops.sync_registry so the monitor lists them.

    Git stays the source of truth; the table is just what the page reads.
    """
    sb = sb or supabase.Client(schema=OPS)
    rows = []
    for b in bindings:
        wb = b.get('workbook', {})
        rows.append({
            'slug': 'excel-' + b['slug'],
            'kind': 'system_to_excel',
            'title': b.get('title', b['slug']),
            'what_it_does': b.get('what_it_does', ''),
            'source': f"excel_sync.{b['dataset']}",
            'target': f"{wb.get('file', 'TBD')} → {wb.get('sheet', 'TBD')}",
            'feeds': b.get('feeds', []),
            'cron_utc': b.get('cron_utc'),
            'sla_minutes': b.get('sla_minutes'),
            'freshness_table': 'excel_sync.datasets',
            'freshness_col': 'built_at',
            'workflow_file': 'excel-sync.yml',
            'enabled': bool(b.get('enabled', False)),
            'sort_order': int(b.get('sort_order', 200)),
        })
    sb.upsert('sync_registry', rows, 'slug')
    return len(rows)
