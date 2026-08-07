"""Supabase PostgREST reader — stdlib only.

Matches the pattern already used by scripts/update_main_avg_3mo.py: urllib
against /rest/v1 rather than the supabase client, so a GitHub Actions run needs
no pip install beyond openpyxl.

Read-only by design. Nothing in excel-sync writes to the mirror.
"""
import json
import os
import re
import urllib.parse
import urllib.request

PAGE = 1000
_ENV_CACHE = {}


def _load_env():
    """Read ../../.env once. Real env vars win (that is what CI sets)."""
    if _ENV_CACHE:
        return _ENV_CACHE
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
    path = os.path.join(root, '.env')
    if os.path.exists(path):
        with open(path, encoding='utf-8') as fh:
            for line in fh:
                m = re.match(r'\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$', line)
                if m:
                    _ENV_CACHE[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return _ENV_CACHE


def credentials():
    env = _load_env()
    url = os.environ.get('SUPABASE_URL') or env.get('SUPABASE_URL')
    key = (os.environ.get('SUPABASE_SERVICE_KEY') or os.environ.get('SUPABASE_ANON_KEY')
           or env.get('SUPABASE_SERVICE_KEY') or env.get('SUPABASE_ANON_KEY'))
    if not url or not key:
        raise SystemExit('SUPABASE_URL / SUPABASE_SERVICE_KEY not found in env or .env')
    return url.rstrip('/'), key


class Client:
    def __init__(self, schema='cin7_mirror'):
        self.base, self.key = credentials()
        self.schema = schema
        self.calls = 0

    def _headers(self):
        return {
            'apikey': self.key,
            'Authorization': 'Bearer ' + self.key,
            'Accept-Profile': self.schema,   # PostgREST reads non-public schemas via this
            'Accept': 'application/json',
        }

    def _get(self, table, params):
        qs = urllib.parse.urlencode(params, safe='.,()*:')
        req = urllib.request.Request(f'{self.base}/rest/v1/{table}?{qs}', headers=self._headers())
        self.calls += 1
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r)

    def select(self, table, columns, filters=None, order=None):
        """Page through a table. `filters` is a list of raw PostgREST clauses,
        e.g. ("order_date", "gte.2026-08-01")."""
        out = []
        offset = 0
        order = order or columns.split(',')[0].strip()
        while True:
            params = [('select', columns), ('order', order),
                      ('offset', str(offset)), ('limit', str(PAGE))]
            for col, clause in (filters or []):
                params.append((col, clause))
            rows = self._get(table, params)
            out.extend(rows)
            if len(rows) < PAGE:
                return out
            offset += PAGE

    def select_in(self, table, columns, column, values, chunk=150):
        """Fetch rows whose `column` is in `values`, batched so the URL stays sane.

        Beats paging the whole table once the scope is one month: ~11 requests
        for August's orders instead of 43 for every sale_line ever mirrored.
        """
        out = []
        values = list(values)
        for i in range(0, len(values), chunk):
            batch = values[i:i + chunk]
            quoted = ','.join('"%s"' % v.replace('"', '') for v in batch)
            offset = 0
            while True:
                params = [('select', columns), ('order', columns.split(',')[0].strip()),
                          (column, f'in.({quoted})'),
                          ('offset', str(offset)), ('limit', str(PAGE))]
                rows = self._get(table, params)
                out.extend(rows)
                if len(rows) < PAGE:
                    break
                offset += PAGE
        return out
