"""Delivery — put a built dataset into the tab that consumes it.

The engine builds a dataset once and stores it; a binding says which tab wants
it. This package is the last mile, and it is deliberately the only part that
touches a real workbook. Everything upstream — sources, specs, gates, the
monitor — is unchanged by how delivery happens, which is why swapping app-only
for delegated auth costs nothing here.

`deliver()` refuses far more often than it writes, and that is the design. The
gates, in the order they fire:

  1. the binding is disabled            -> refuse unless --force
  2. the header row does not match      -> refuse. A shifted column silently
                                           breaks 2,556 VLOOKUPs.
  3. never snapshotted before           -> take one, then continue
  4. a formula sits in our rectangle    -> refuse. This is the one with no undo.
  5. nothing to write                   -> refuse. An empty dataset blanking a
                                           live tab is a bug, not a refresh.

Only then does it write, and even then `write=False` is the default: the caller
has to ask for it in so many words.
"""
import datetime
import os

from .. import flat, pivot, supabase
from . import auth, graph, local_excel  # noqa: F401  (auth re-exported for the CLI)

# Two transports, one interface. 'graph' is the destination and is written and
# working; it is unreachable until an administrator consents (AADSTS90094 on
# 2026-08-11). 'local' drives Excel over the OneDrive-synced copy and needs no
# tenant permission at all, so it is the default until that changes. Switching
# back is this one variable.
TRANSPORT = os.environ.get('EXCEL_SYNC_TRANSPORT', 'local')

CONFIG = {
    'host': os.environ.get('GRAPH_SHAREPOINT_HOST', 'rapidled.sharepoint.com'),
    'site_path': os.environ.get('GRAPH_SITE_PATH', ''),        # '' = the root site
    'local_root': os.environ.get(
        'EXCEL_SYNC_LOCAL_ROOT',
        os.path.expanduser(r'~\RapidLED\WorkDocs - Rapid LED - Data')),
}


def _count(n):
    """1247 -> '1 247'. A space, not a comma: the comma is already doing a job in
    the date beside it, and thousands separators differ by locale anyway."""
    return f'{n:,}'.replace(',', ' ')


def _stamp(rows):
    """The one-liner, in the cell somebody already types 'Updated: 10-Aug' into."""
    return f'Updated {_now_label()} · {_count(rows)} products'


# ─────────────────────────────────────────────────────────────────────────────
# the status block
# ─────────────────────────────────────────────────────────────────────────────
# A one-line stamp in one cell is enough for whoever wrote it and no use to
# anybody else. These tabs are read by branch managers who do not know what a
# dataset is, and the question they need answered on sight is "did this run, and
# what period am I looking at?".
#
# The period matters more than it sounds. Three of the seven workbooks currently
# show a `Sales MTD` tab whose own preamble says a month that is not this one —
# Brisbane sat on June figures under a hand-typed "Updated 10-Aug", Melbourne on
# July — because the stamp and the data come from different hands. Writing both
# from the same run is the only way they cannot disagree.
#
# Row count is the cheapest tamper check there is: 1 247 today and 3 tomorrow is
# obvious to someone who understands nothing else on this page.
def _pretty_date(iso):
    """'2026-08-01' -> '1 Aug 2026'. No leading zero: this is read, not sorted."""
    try:
        d = datetime.date.fromisoformat(str(iso).strip())
        return f'{d.day} {d:%b %Y}'
    except (ValueError, TypeError):
        return str(iso).strip()


def _period_label(meta):
    """'2026-08-01..2026-08-31' -> '01 Aug 2026 - 31 Aug 2026'. None for stock."""
    p = (meta or {}).get('period')
    if not p:
        return None
    if '..' in str(p):
        a, b = str(p).split('..', 1)
        return f'{_pretty_date(a)} - {_pretty_date(b)}'
    return str(p)


# Brisbane, always, on every branch's tab. Queensland does not observe daylight
# saving, so UTC+10 is correct all year and needs no timezone database — and one
# fixed reference beats seven local ones, because "is this today's number?" is
# the only question being asked and it must have one answer.
BRISBANE = datetime.timezone(datetime.timedelta(hours=10))

# The status block is always written as this many rows, whatever it has to say.
# Must match the height tools/survey_workbooks.py checks is empty when it picks
# the anchor — change one and change the other.
BLOCK_ROWS = 4


def _now_label():
    """The timestamp a warehouse manager reads at a glance.

    Two things it must survive. Excel WILL parse a bare `14 Aug 2026 08:53` into
    a datetime and re-render it `8/14/26` — measured on the first real write,
    US order, to an Australian reader, in the one cell whose entire job is to be
    unambiguous. The trailing `(Brisbane)` defeats that parse and also says the
    timezone in the only way a non-technical reader wants it said.

    The weekday is there for the same reason: `Thu` answers "is this today?"
    without anyone doing date arithmetic.
    """
    now = datetime.datetime.now(datetime.timezone.utc).astimezone(BRISBANE)
    hour = now.hour % 12 or 12
    return f"{now:%a} {now.day} {now:%b %Y}, {hour}:{now:%M} {now:%p}".replace('AM', 'am').replace('PM', 'pm') + ' (Brisbane)'


def _status_grid(meta, rows):
    """Three lines at most, and no line that answers a question nobody asked.

    'Source' was dropped on request: whoever opens this tab wants to know it is
    current, not where it came from. Row count stays — it costs one line and it
    is the only thing on the page that makes a half-written refresh obvious.
    """
    grid = [['Updated', _now_label()]]
    period = _period_label(meta)
    if period:
        # Only the sales tabs cover a period. On a stock tab the period IS the
        # timestamp above, and repeating it just adds a line to read.
        grid.append(['Sales period', period])
    grid.append(['Products', _count(rows)])

    # Always the same rectangle, blank-padded. A block that shrinks would
    # otherwise leave the previous run's last line stranded underneath, still
    # looking current — which is the exact failure this block exists to prevent,
    # reproduced inside the fix. Seen for real: dropping 'Source' left it behind.
    # BLOCK_ROWS is what tools/survey_workbooks.py proved free before choosing
    # the anchor, so padding to it can never reach a cell somebody else owns.
    while len(grid) < BLOCK_ROWS:
        grid.append(['', ''])
    return grid


def _overlaps(a, b):
    """Do two A1 ranges intersect? Both may be single cells."""
    r1, c1, r2, c2 = graph.parse_range(a)
    s1, d1, s2, d2 = graph.parse_range(b)
    return not (r2 < s1 or s2 < r1 or c2 < d1 or d2 < c1)


def deliver(binding, sb=None, write=False, force=False, mode=None,
            file_override=None, verbose=True, transport=None, root=None):
    """Write one binding's tab. Returns a dict describing what happened.

    Two ways to aim this somewhere safe, answering different questions:

      `file_override`  one binding at one workbook — proving a single tab.
      `root`           EVERY binding at a folder of copies — rehearsing the whole
                       run before it goes near the live library.

    The second matters more than it looks: a rehearsal that needs 21 flags is a
    rehearsal nobody runs. Writing is the only irreversible step in this project,
    and it should be spent first on files nobody depends on.
    """
    sb = sb or supabase.Client(schema='public')
    slug = binding['slug']
    wb = binding['workbook']
    lay = binding['layout']
    sheet = wb['sheet']
    filename = file_override or wb['file']
    out = {'binding': slug, 'file': filename, 'sheet': sheet, 'wrote': False}

    def say(msg):
        if verbose:
            print(msg)

    say(f"\n{slug} → {filename} / {sheet}")

    # ── gate 1: is this binding meant to run at all? ────────────────────────
    if not binding.get('enabled') and not force:
        out['status'] = 'disabled'
        say('  SKIP — binding is disabled. --force to override.')
        return out

    # ── gate 0: is the dataset we are about to write actually current? ──────
    # Added 2026-08-11 after this fired for real. The Sales MTD tab held FRESHER
    # numbers than the dataset built the night before, so delivering would have
    # replaced good figures with stale ones and reported success. Nothing else
    # here could catch it: the rows were internally consistent and every other
    # gate passed. Staleness is invisible from inside the data.
    meta, stale = _dataset_age(sb, binding, force, say)
    if stale:
        out['status'] = 'blocked'
        out['error'] = stale
        return out

    # ── build the rectangle from the stored dataset ─────────────────────────
    rows = flat.fetch_dataset(binding['dataset'], sb)
    tab = flat.build(rows, binding)
    grid, cols = tab['grid'], tab['cols']
    headers = [c['header'] for c in cols]

    if tab['missing_locations']:
        out['status'] = 'blocked'
        out['error'] = f"locations absent from the dataset: {tab['missing_locations']}"
        say(f"  REFUSE — {out['error']}")
        return out

    # ── gate 5 (early): an empty build must never blank a live tab ──────────
    if not grid:
        out['status'] = 'blocked'
        out['error'] = 'dataset produced 0 rows for this binding'
        say('  REFUSE — 0 rows. An empty write would wipe the tab.')
        return out

    anchor = lay['data_anchor']
    a_row, a_col = graph.parse_cell(anchor)
    address = flat.a1(anchor, len(grid), len(cols))
    say(f'  {len(grid)} rows x {len(cols)} cols -> {address}')

    # ── locate the workbook ─────────────────────────────────────────────────
    tname = transport or TRANSPORT
    cls = local_excel.TRANSPORTS.get(tname)
    if cls is None:
        raise SystemExit(f'unknown transport {tname!r} — one of {list(local_excel.TRANSPORTS)}')
    g = cls(sb, mode)
    say(f'  transport: {tname}')

    # A rehearsal opens read-only, so it cannot write even by mistake.
    cfg = dict(CONFIG, local_root=os.path.expanduser(root)) if root else CONFIG
    if root:
        say(f'  root override: {cfg["local_root"]}')
    handle = g.open(binding, filename, cfg, read_only=not write)
    say(f"  found: {handle['describe']}")
    out['transport'] = tname
    out['item_id'], out['location'] = handle.get('id'), handle.get('location')

    state, no_schema = _state(sb, slug, required=write)
    if no_schema:
        say('  ! db/003_graph_delivery.sql not deployed — no snapshot or extent '
            'history.\n    Fine for a rehearsal; required before --write.')

    try:
        # ── gate 2: the header row must still be where we think it is ───────
        # Header lives directly above the anchor, starting in the same column.
        hdr_addr = flat.a1(f'{graph.num_to_col(a_col)}{a_row - 1}', 1, len(cols))
        live = g.read_range(sheet, hdr_addr)
        live_hdr = [('' if v is None else str(v).strip())
                    for v in (live.get('values') or [[]])[0]]
        want_hdr = [str(h).strip() for h in headers]

        # NOT overridable by --force, and that is the whole point of it.
        #
        # It used to be. Proven on 2026-08-17 by inserting a 'Notes' column into
        # a copy's SOH Main and running with --force: the gate saw the mismatch,
        # said so, and wrote anyway. Every column landed one to the left of its
        # own header — the tab then read
        #     SKU | Notes | Quantity on hand | Allocated | On order | Available
        #      ↑     on_hand    allocated       on_order    available
        # and the 1,716 formulas doing VLOOKUP(...,A:E,5) returned On order while
        # believing it was Available. Plausible numbers, wrong field, no #REF!,
        # no #N/A, nothing to notice.
        #
        # The trial runs with --force, because the bindings ship disabled and
        # --force is what gets past that. So the flag that makes a rehearsal
        # possible was also switching off the guard the rehearsal exists to
        # trust. Those two things must never share a flag.
        #
        # There is no legitimate force here either: if the header moved, the
        # answer is to re-run tools/survey_workbooks.py and regenerate the
        # binding, not to write through it.
        if live_hdr != want_hdr:
            out['status'] = 'blocked'
            out['error'] = f'header mismatch at {hdr_addr}: sheet has {live_hdr}, binding wants {want_hdr}'
            say('  REFUSE — header row moved or renamed.')
            say(f'    sheet   {live_hdr}')
            say(f'    binding {want_hdr}')
            say('    a shifted column breaks every VLOOKUP that reads this tab,')
            say('    silently — the numbers stay plausible. --force does NOT override this.')
            say('    fix: python tools/survey_workbooks.py --emit-bindings out/bindings')
            _record(sb, slug, None, None, None, None, None,
                    handle.get('location'), handle.get('id'), 'blocked', out['error'])
            return out

        layout_hash = graph._layout_hash(live_hdr)

        # ── gate 3: snapshot before the first write, or after a reshuffle ────
        taken = 0 if no_schema else (sb.rpc('excel_snapshot_count', {'p_binding': slug}) or 0)
        need_snap = (not no_schema
                     and ((not taken) or state.get('layout_hash') not in (None, layout_hash)))
        snapshot = None
        if need_snap:
            reason = 'pre-first-write' if not taken else 'layout-changed'
            say(f'  snapshot ({reason}) — reading the whole tab, values and formulas…')
            snapshot = g.used_range(sheet)
            n_formula = sum(1 for r in (snapshot.get('formulas') or [])
                            for v in (r or []) if isinstance(v, str) and v.startswith('='))
            sb.rpc('excel_snapshot_save', {
                'p_binding': slug, 'p_workbook': filename, 'p_sheet': sheet,
                'p_address': snapshot.get('address'), 'p_reason': reason,
                'p_formula_cells': n_formula,
                'p_values': snapshot.get('values'), 'p_formulas': snapshot.get('formulas')})
            say(f"    saved {snapshot.get('address')} · {n_formula} formula cells on the tab")
        else:
            # Not snapshotting again, but we still need the formulas to check.
            snapshot = g.used_range(sheet)

        # ── the status block, and the stale preamble it replaces ────────────
        status = binding.get('status') or {}
        status_grid = _status_grid(meta, len(grid))
        block_addr = (flat.a1(status['block'], len(status_grid), 2)
                      if status.get('block') else None)
        clear_addr_pre = status.get('clear')

        # A misconfigured `clear` is the one way this feature could destroy the
        # data it just wrote, so it is checked rather than trusted.
        for label, addr in (('the data rectangle', address), ('the status block', block_addr)):
            if clear_addr_pre and addr and _overlaps(clear_addr_pre, addr):
                raise SystemExit(
                    f"binding '{slug}': [status] clear = {clear_addr_pre!r} overlaps "
                    f'{label} ({addr}). It would erase what this run writes.')

        # ── gate 4: no formula may be inside anything we overwrite ──────────
        # Not just the data rectangle: the status block and the preamble we
        # clear are writes too, and a formula there dies exactly as permanently.
        targets = [('data', address)]
        if status.get('cell'):
            targets.append(('status cell', status['cell']))
        if block_addr:
            targets.append(('status block', block_addr))
        if clear_addr_pre:
            targets.append(('preamble clear', clear_addr_pre))

        for what, addr in targets:
            r1, c1, r2, c2 = graph.parse_range(addr)
            hits = graph._formulas_in(snapshot, r1, c1, r2, c2)
            if not hits:
                continue
            out['status'] = 'blocked'
            out['error'] = (f'{len(hits)} formula cell(s) inside {what} {addr}, '
                            f'first {hits[0][0]}')
            say(f'  REFUSE — {len(hits)} formula(s) inside the {what} area ({addr}):')
            for cell, txt in hits[:5]:
                say(f'    {cell}  {txt}')
            say('    writing values here would replace them with numbers, permanently.')
            _record(sb, slug, None, None, None, None, layout_hash,
                    handle.get('location'), handle.get('id'), 'blocked', out['error'])
            return out

        out.update({'rows': len(grid), 'cols': len(cols), 'address': address,
                    'formula_cells_on_tab': sum(
                        1 for r in (snapshot.get('formulas') or []) for v in (r or [])
                        if isinstance(v, str) and v.startswith('='))})

        # ── what would be cleared if the data shrank ─────────────────────────
        # On the first write there is no recorded extent, so fall back to what
        # the tab actually holds. Without this, a shorter dataset would leave
        # the tail of the human-pasted block sitting under our rows.
        prev_rows = state.get('last_rows') or 0
        if not prev_rows:
            prev_rows = graph._existing_extent(snapshot, a_row, a_col)
            if prev_rows:
                say(f'  tab currently holds {prev_rows} rows (no write history — measured)')
        clear_addr = None
        if prev_rows > len(grid):
            first = a_row + len(grid)
            last = a_row + prev_rows - 1
            clear_addr = (f'{graph.num_to_col(a_col)}{first}:'
                          f'{graph.num_to_col(a_col + len(cols) - 1)}{last}')
            out['clear'] = clear_addr
            say(f'  shrank {prev_rows} -> {len(grid)} rows; will clear {clear_addr}')

        batches = graph._batches(grid, a_row, a_col, len(cols))
        out['batches'] = len(batches)

        # ── the dry run stops here, having proved everything but the write ───
        if not write:
            out['status'] = 'dry-run'
            say(f'  DRY RUN — would write {len(grid)} rows in {len(batches)} call(s):')
            for addr, chunk in batches:
                say(f'    {addr}  ({len(chunk)} rows)')
            if clear_addr:
                say(f'    clear {clear_addr}')
            if status.get('cell'):
                say(f"  status cell {status['cell']}: {_stamp(len(grid))}")
            if clear_addr_pre:
                say(f'  would blank the stale preamble at {clear_addr_pre}')
            if block_addr:
                say(f'  status block {block_addr}:')
                for label, value in status_grid:
                    say(f'    {label:<9} {value}')
            if not status.get('cell') and not block_addr:
                say('  ! no [status] cell or block — nobody reading this tab will be')
                say('    able to tell whether the run happened.')
            say('  nothing was written. Add --write to do it for real.')
            return out

        # ── write ───────────────────────────────────────────────────────────
        if clear_addr:
            g.clear_range(sheet, clear_addr)
            say(f'  cleared {clear_addr}')

        for addr, chunk in batches:
            g.write_range(sheet, addr, chunk)
            say(f'  wrote {addr} ({len(chunk)} rows)')

        # Blank the export's own preamble BEFORE stamping ours, so that if the
        # run dies between the two the tab shows nothing rather than a period
        # that contradicts the rows above it.
        if clear_addr_pre:
            g.clear_range(sheet, clear_addr_pre)
            say(f'  blanked stale preamble {clear_addr_pre}')

        if status.get('cell'):
            g.write_range(sheet, status['cell'], [[_stamp(len(grid))]])
            say(f"  status {status['cell']}: {_stamp(len(grid))}")

        if block_addr:
            g.write_range(sheet, block_addr, status_grid)
            say(f'  status block {block_addr}:')
            for label, value in status_grid:
                say(f'    {label:<9} {value}')

        # Graph persists as it goes; Excel needs telling. Either way this is the
        # point of no return, and it is deliberately the last thing that happens.
        g.save()

        out['wrote'] = True
        out['status'] = 'ok'
        _record(sb, slug, address, len(grid), len(cols), None, layout_hash,
                handle.get('location'), handle.get('id'), 'ok', None)
        say(f'  OK — {len(grid)} rows in {g.calls} calls')
        return out

    finally:
        g.close()


def _dataset_age(sb, binding, force, say):
    """Refuse to deliver a dataset older than the binding's own SLA.

    `sla_minutes` already states how fresh this tab is expected to be, so it is
    the honest threshold — no second knob to keep in step with the first.

    Returns (dataset_meta, error). The meta comes back either way because the
    status block needs its `period` — the same read answers both questions.
    """
    slug = binding['dataset']
    try:
        rows = sb.rpc('excel_datasets', {}) or []
    except SystemExit as e:
        say(f'  ! could not read dataset freshness: {e}')
        return {}, None
    match = [d for d in rows if d.get('slug') == slug]
    if not match or not match[0].get('built_at'):
        say(f'  ! dataset {slug!r} has no build record — cannot judge freshness')
        return (match[0] if match else {}), None
    meta = match[0]

    built = meta['built_at'].replace('Z', '+00:00')
    try:
        when = datetime.datetime.fromisoformat(built)
    except ValueError:
        return meta, None
    age_min = (datetime.datetime.now(datetime.timezone.utc)
               - when.astimezone(datetime.timezone.utc)).total_seconds() / 60.0
    limit = float(binding.get('sla_minutes') or 1560)

    say(f'  dataset {slug} built {age_min / 60:.1f}h ago '
        f'({meta.get("row_count")} rows, limit {limit / 60:.0f}h)'
        + (f', covers {_period_label(meta)}' if _period_label(meta) else ''))
    if age_min <= limit:
        return meta, None
    msg = (f'dataset {slug} is {age_min / 60:.1f}h old, past its '
           f'{limit / 60:.0f}h SLA — rebuild before delivering')
    if force:
        say(f'  ! STALE, overridden by --force: {msg}')
        return meta, None
    say(f'  REFUSE — {msg}')
    say('    writing it would replace fresher numbers in the tab with older ones.')
    say(f'    fix:  python -m engine build {slug} --publish')
    return meta, msg


def _state(sb, slug, required):
    """Prior extent + layout for this binding. Returns (state, schema_missing).

    A rehearsal must run before anything is deployed — that is when you most want
    to see what it would do. A real write must not: without the schema there is
    no snapshot, and the snapshot is the only undo this project has.
    """
    try:
        rows = sb.rpc('excel_binding_state_get', {'p_binding': slug}) or []
        return (rows[0] if rows else {}), False
    except SystemExit as e:
        if 'PGRST202' not in str(e):
            raise
        if required:
            raise SystemExit(
                'Refusing to write: db/003_graph_delivery.sql is not deployed.\n'
                '  Without it there is no snapshot table, and the snapshot is the\n'
                '  only way back if this goes wrong. Paste it into the Supabase\n'
                '  SQL editor first.')
        return {}, True


def _record(sb, slug, address, rows, cols, checksum, layout_hash,
            drive_id, item_id, status, error):
    try:
        sb.rpc('excel_binding_state_set', {
            'p_binding': slug, 'p_address': address, 'p_rows': rows, 'p_cols': cols,
            'p_checksum': checksum, 'p_layout_hash': layout_hash,
            'p_drive_id': drive_id, 'p_item_id': item_id,
            'p_status': status, 'p_error': error})
    except SystemExit as e:
        print(f'  ! could not record binding state: {e}')


def deliver_all(slugs=None, **kw):
    """Every enabled binding, or the ones named. One failing must not stop the rest."""
    sb = kw.pop('sb', None) or supabase.Client(schema='public')
    results = []
    for slug in (slugs or pivot.list_bindings()):
        b = pivot.load_binding(slug)
        try:
            results.append(deliver(b, sb=sb, **kw))
        except SystemExit as e:
            print(f'  FAILED {slug}: {e}')
            results.append({'binding': slug, 'status': 'failed', 'error': str(e)})
    return results
