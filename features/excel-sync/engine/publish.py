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
    sb = sb or supabase.Client(schema='public')
    metrics = spec['metrics']
    digest = checksum(rows, metrics)

    prev = [d for d in (sb.rpc('excel_datasets', {}) or []) if d['slug'] == spec['slug']]
    changed = not prev or prev[0].get('checksum') != digest

    payload = [{'sku': r['sku'], 'location': r['location'],
                'metrics': {m['field']: r.get(m['field']) for m in metrics}}
               for r in rows]

    written = sb.rpc('excel_publish_dataset', {
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
        self.sb = sb or supabase.Client(schema='public')
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
            self.run_id = self.sb.rpc('ops_run_start', {
                'p_slug': self.slug, 'p_trigger': self.trigger, 'p_run_url': run_url})
        except Exception as e:                       # noqa: BLE001
            # Run logging must never be the reason a sync fails — and it used to
            # be. This caught SystemExit only, which is what supabase._send
            # raises for an HTTP error. A connection-level failure (DNS down,
            # laptop offline, TLS, read timeout) raises URLError or
            # TimeoutError, escaped this handler, and killed the whole delivery
            # from inside the bookkeeping that is supposed to be incidental to
            # it. Catch everything: a lost run row is a monitoring gap, an
            # aborted delivery is an outage.
            print(f'  ! could not open run log: {type(e).__name__}: {e}')
        return self

    def finish(self, status, error=None):
        if self.run_id is None:
            return
        try:
            self.sb.rpc('ops_run_finish', {
                'p_run_id': self.run_id,
                'p_status': status,
                'p_duration_ms': int((time.time() - self.t0) * 1000),
                'p_rows_written': self.rows_written,
                'p_error': (error or '')[:2000] or None,
                'p_stats': self.stats,
            })
        except Exception as e:                       # noqa: BLE001
            print(f'  ! could not close run log: {type(e).__name__}: {e}')

    def __exit__(self, exc_type, exc, tb):
        if exc is not None:
            self.finish('failed', f'{exc_type.__name__}: {exc}')
        return False   # never swallow


# ─────────────────────────────────────────────────────────────────────────────
def register_datasets(specs, sb=None):
    """Put each dataset build on the Sync Monitor's Excel tab.

    Freshness comes from the RUN LOG, not excel_sync.datasets.built_at: that
    column would be read as max() over the whole table, so both datasets would
    report the same age and a stalled one would hide behind a healthy one.
    """
    sb = sb or supabase.Client(schema='public')
    rows = []
    for s in specs:
        cols = ', '.join(m['header'] for m in s['metrics'])
        rows.append({
            'slug': 'excel-dataset-' + s['slug'],
            'kind': 'system_to_excel',
            'title': s.get('title', s['slug']),
            'what_it_does': f"Builds {cols} per SKU x warehouse from the mirror, "
                            f"for every workbook bound to it.",
            'source': f"cin7_mirror ({s['source']})",
            'target': f"excel_sync.dataset_rows [{s['slug']}]",
            'feeds': [f"Excel bindings on {s['slug']}"],
            'cron_utc': s.get('cron_utc', '0 20 * * 0-4'),
            'sla_minutes': int(s.get('sla_minutes', 1560)),
            'freshness_table': None,
            'freshness_col': None,
            'workflow_file': 'excel-sync.yml',
            'enabled': True,
            'sort_order': int(s.get('sort_order', 200)),
        })
    return sb.rpc('ops_register_bindings', {'p_rows': rows})


def register_bindings(bindings, sb=None):
    """Mirror the binding TOMLs into ops.sync_registry so the monitor lists them.

    Git stays the source of truth; the table is just what the page reads.
    """
    sb = sb or supabase.Client(schema='public')
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
    return sb.rpc('ops_register_bindings', {'p_rows': rows})
