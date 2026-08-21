"""Write a dataset into a live workbook tab, via the Microsoft Graph workbook API.

Writing the cells is the easy part and takes seconds. Everything else in here
exists because we chose to write *over a tab people already use*, which trades
their convenience for our risk. Four things can go wrong, all of them silent:

  a formula inside our rectangle   A PATCH of values replaces it with a number,
                                   permanently. So: snapshot first, and refuse
                                   to write if the snapshot shows any formula
                                   where we are about to write.

  someone moved a column           Column F of 'SOH Main' is load-bearing: 2,556
                                   VLOOKUPs read B:F index 5. If a column got
                                   inserted, writing our old shape corrupts every
                                   one of them. So: compare the header row and
                                   refuse on mismatch.

  the data got shorter             Yesterday's tail rows survive and read as
                                   today's. So: remember our own extent and
                                   clear the excess before writing.

  someone has the file open        Graph writes anyway and edits can cross. The
                                   06:00 Sydney cron makes it unlikely, not
                                   impossible; a persistent session keeps our
                                   own writes coherent, and the run log records
                                   what happened rather than swallowing it.

Refusing is always the right default here. A tab that did not refresh is
obvious to whoever reads it; a tab that refreshed wrongly is not.
"""
import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from . import auth

GRAPH = 'https://graph.microsoft.com/v1.0'

# Graph rejects very large request bodies, and a smaller batch also means a
# retry costs less. ~1 MB was measured to put stock-level at 3 calls.
MAX_BATCH_BYTES = 1_000_000


# ─────────────────────────────────────────────────────────────────────────────
# A1 helpers. flat.a1() builds an address; here we need to take them apart.
# ─────────────────────────────────────────────────────────────────────────────
def col_to_num(col):
    n = 0
    for ch in col.upper():
        n = n * 26 + (ord(ch) - 64)
    return n


def num_to_col(n):
    s = ''
    while n:
        n, rem = divmod(n - 1, 26)
        s = chr(65 + rem) + s
    return s


def parse_cell(ref):
    m = re.match(r'^\$?([A-Z]+)\$?(\d+)$', ref.upper())
    if not m:
        raise SystemExit(f'bad cell reference {ref!r}')
    return int(m.group(2)), col_to_num(m.group(1))          # (row, col), 1-based


def parse_range(addr):
    """'SOH Main!B3:F2935' or 'B3:F2935' -> (r1, c1, r2, c2)."""
    addr = addr.split('!')[-1]
    a, _, b = addr.partition(':')
    r1, c1 = parse_cell(a)
    r2, c2 = parse_cell(b) if b else (r1, c1)
    return r1, c1, r2, c2


# ─────────────────────────────────────────────────────────────────────────────
class Graph:
    """Transport: the workbook lives in SharePoint, reached over HTTP.

    Blocked as of 2026-08-11 — the tenant refuses both app-only consent and user
    consent (AADSTS90094). Kept whole and working: the day an admin consents,
    this becomes the transport again by changing one flag. See local_excel.py
    for the interface it shares, and which is in use meanwhile.
    """
    name = 'graph'

    def __init__(self, sb=None, mode=None):
        self._sb = sb
        self._mode = mode
        self._token = None
        self.session = None
        self.calls = 0
        self.drive_id = None
        self.item_id = None

    def _auth(self):
        if self._token is None:
            self._token = auth.token(self._sb, self._mode)
        return self._token

    def _headers(self):
        h = {'Authorization': f'Bearer {self._auth()}', 'Accept': 'application/json'}
        if self.session:
            h['workbook-session-id'] = self.session
        return h

    def request(self, method, path, body=None, retries=4):
        url = path if path.startswith('http') else f'{GRAPH}{path}'
        for attempt in range(retries + 1):
            headers = self._headers()
            data = None
            if body is not None:
                data = json.dumps(body).encode()
                headers['Content-Type'] = 'application/json'
            req = urllib.request.Request(url, data=data, method=method, headers=headers)
            self.calls += 1
            try:
                with urllib.request.urlopen(req, timeout=300) as r:
                    raw = r.read()
                    return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as e:
                raw = e.read().decode('utf-8', 'replace')
                # 429/503 are the throttle and they carry the wait. Anything else
                # is a real answer and retrying it just repeats the mistake.
                if e.code in (429, 503, 504) and attempt < retries:
                    wait = int(e.headers.get('Retry-After') or (2 ** attempt) * 5)
                    print(f'    throttled {e.code}, waiting {wait}s')
                    time.sleep(wait)
                    continue
                raise SystemExit(f'{method} {url.split("/v1.0")[-1][:120]} -> {e.code}: {raw[:400]}')
            except urllib.error.URLError as e:
                if attempt < retries:
                    time.sleep((2 ** attempt) * 3)
                    continue
                raise SystemExit(f'{method} failed: {e}')

    # ── the shared transport interface ──────────────────────────────────────
    def open(self, binding, filename, config, read_only=False):
        """host + library + folder + file -> a workbook session.

        `read_only` opens a non-persisting session: changes live only in that
        session and are discarded when it closes. The local transport enforces
        the same promise through Excel; a rehearsal must be unable to write, not
        merely decline to.

        Resolved by path rather than by a sharing URL on purpose: these workbooks
        are renamed every month ('Coffs Harbour Aug 26' -> 'Sep 26'), and a path
        survives that with a one-word edit to the binding. A stored item ID does
        not — it points at the archived copy from then on, and nothing complains.
        """
        wb = binding['workbook']
        host, site_path = config['host'], config.get('site_path', '')
        site_ref = f'{host}:{site_path}' if site_path else host
        site = self.request('GET', f'/sites/{site_ref}?$select=id,displayName')
        drives = self.request('GET', f"/sites/{site['id']}/drives?$select=id,name")
        match = [d for d in drives.get('value', []) if d.get('name') == wb['library']]
        if not match:
            names = ', '.join(sorted(d.get('name', '?') for d in drives.get('value', [])))
            raise SystemExit(f"library {wb['library']!r} not found on site "
                             f"{site.get('displayName')!r}.\n  libraries present: {names}")
        self.drive_id = match[0]['id']

        rel = '/'.join(p for p in [wb.get('folder'), filename] if p).strip('/')
        item = self.request('GET', f'/drives/{self.drive_id}/root:/{urllib.parse.quote(rel)}'
                                   '?$select=id,name,size,lastModifiedDateTime')
        self.item_id = item['id']

        r = self.request('POST', f'/drives/{self.drive_id}/items/{self.item_id}'
                                 '/workbook/createSession',
                         {'persistChanges': not read_only})
        self.session = r.get('id')
        return {'id': self.item_id, 'location': self.drive_id,
                'describe': f"{item['name']} · {item.get('size', 0)} bytes · "
                            f"modified {item.get('lastModifiedDateTime')}"
                            + (' · session does NOT persist' if read_only else '')}

    def close(self, saved=False):
        if not self.session:
            return
        try:
            self.request('POST', f'/drives/{self.drive_id}/items/{self.item_id}'
                                 '/workbook/closeSession', {})
        except SystemExit as e:
            # A session that will not close expires on its own. Never turn this
            # into the reason a good write is reported as failed.
            print(f'  ! closeSession: {e}')
        finally:
            self.session = None

    def _sheet(self, sheet):
        name = urllib.parse.quote(sheet.replace("'", "''"), safe='')
        return f"/drives/{self.drive_id}/items/{self.item_id}/workbook/worksheets('{name}')"

    def used_range(self, sheet):
        """Values AND formulas in one call — the snapshot, and the formula guard."""
        return self.request('GET', self._sheet(sheet) + '/usedRange(valuesOnly=false)'
                            '?$select=address,rowCount,columnCount,values,formulas')

    def read_range(self, sheet, address):
        return self.request('GET', self._sheet(sheet)
                            + f"/range(address='{address}')?$select=address,values,formulas")

    def write_range(self, sheet, address, values):
        return self.request('PATCH', self._sheet(sheet)
                            + f"/range(address='{address}')", {'values': values})

    def clear_range(self, sheet, address):
        return self.request('POST', self._sheet(sheet)
                            + f"/range(address='{address}')/clear", {'applyTo': 'contents'})

    def save(self):
        """Graph persists on write when the session says so. Nothing to do."""
        return None


# ─────────────────────────────────────────────────────────────────────────────
def _batches(grid, anchor_row, anchor_col, n_cols):
    """Split the grid into ~1 MB chunks, each with its own A1 address."""
    out, start, size = [], 0, 0
    for i, row in enumerate(grid):
        size += len(json.dumps(row, default=str))
        if size >= MAX_BATCH_BYTES and i > start:
            out.append((start, i))
            start, size = i, 0
    if start < len(grid):
        out.append((start, len(grid)))

    end_col = num_to_col(anchor_col + n_cols - 1)
    start_col = num_to_col(anchor_col)
    return [(f'{start_col}{anchor_row + a}:{end_col}{anchor_row + b - 1}', grid[a:b])
            for a, b in out]


def _layout_hash(headers):
    return hashlib.sha256('\x00'.join(str(h) for h in headers).encode()).hexdigest()[:16]


def _existing_extent(snapshot, anchor_row, anchor_col):
    """How many rows the tab already holds below the anchor, by its key column.

    Needed for the FIRST write, and only for it. After that our own recorded
    extent is authoritative. Before it, the tab holds a block a human pasted,
    and we have no record of how far it reaches — so if today's dataset is
    shorter, the tail of that paste would survive underneath and read as current.

    Counts down the key column from the anchor until a blank, which is the same
    rule a person reading the tab applies.
    """
    addr = snapshot.get('address', '')
    grid = snapshot.get('values') or []
    if not addr or not grid:
        return 0
    sr, sc, _, _ = parse_range(addr)
    ci = anchor_col - sc
    n = 0
    r = anchor_row - sr
    while 0 <= r < len(grid):
        row = grid[r] or []
        v = row[ci] if 0 <= ci < len(row) else None
        if v is None or str(v).strip() == '':
            break
        n += 1
        r += 1
    return n


def _formulas_in(snapshot, r1, c1, r2, c2):
    """Which cells of the target rectangle already hold a formula?

    The tabs were checked by hand and hold none — but 'checked once, in August'
    is not a guarantee, and this is the failure that has no undo.
    """
    addr = snapshot.get('address', '')
    if not addr:
        return []
    sr, sc, _, _ = parse_range(addr)
    grid = snapshot.get('formulas') or []
    hits = []
    for r in range(r1, r2 + 1):
        gi = r - sr
        if gi < 0 or gi >= len(grid):
            continue
        row = grid[gi] or []
        for c in range(c1, c2 + 1):
            ci = c - sc
            if 0 <= ci < len(row):
                v = row[ci]
                if isinstance(v, str) and v.startswith('='):
                    hits.append((f'{num_to_col(c)}{r}', v[:60]))
    return hits
