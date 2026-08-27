"""Did this morning's build actually happen? Asked from somewhere else.

WHAT THIS WATCHES, AND WHY IT CHANGED
-------------------------------------
Originally this asked whether a Windows PC had pushed values into the branch
workbooks. That machine is retired: the workbooks now carry Power Query and
PULL from excel_sync.datasets, so "delivery" is no longer an event on a PC —
it is the dataset being fresh at the moment someone opens the file.

So the guard moved with the architecture. It now asks the two questions the
pull model can actually fail:

  1. Did the dataset get REBUILT? GitHub's scheduler drops slots. On 27/08 the
     06:55 Brisbane slot never queued. There was no failed run to email about
     — a job that never starts cannot report — and the first person in read
     figures built at 18:09 the night before. Nothing anywhere noticed.

  2. Is the DATA under it fresh? A build succeeds happily against a mirror that
     stopped filling. built_at then says "today" while the numbers are days
     old, which is the worst shape this can take: confidently wrong.

A FAILED RUN OF THIS JOB IS THE NOTIFICATION. GitHub emails the repo owner on
a workflow failure and pushes it through the mobile app. That is the only push
channel this estate has, it costs no new secret, and it lands somewhere a
person already looks.

That channel only works while it stays quiet when things are fine, and it did
not: this job failed every weekday from 18/08 to 27/08 over four Hobart
bindings belonging to the retired push model. The one alarm the estate owns
had been crying wolf for nine days, which is why nobody heard the real miss.
Keeping it silent when healthy is not tidiness — it is the whole mechanism.

    python tools/heartbeat.py                  # exit 1 if anything is stale
    python tools/heartbeat.py --max-build-hours 6
    python tools/heartbeat.py --warn-only      # report, always exit 0

Needs SUPABASE_URL and SUPABASE_SERVICE_KEY, like everything else here.
"""
import argparse
import datetime as dt
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from engine import pivot, supabase                          # noqa: E402

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding='utf-8', errors='replace')
    except (AttributeError, ValueError):
        pass


def _age_hours(stamp):
    """Hours between an ISO timestamp and now, or None if unparseable."""
    if not stamp:
        return None
    try:
        t = dt.datetime.fromisoformat(str(stamp).replace('Z', '+00:00'))
    except ValueError:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.timezone.utc)
    return (dt.datetime.now(dt.timezone.utc) - t).total_seconds() / 3600.0


def check_datasets(sb, max_build_h, max_data_h):
    """The real guard: every dataset rebuilt recently, over recent data.

    Thresholds are wall-clock rather than business minutes because this only
    runs on weekday mornings, and they are measured rather than reasoned.

    Across the runs since the hourly schedule began on 24/08, the newest build
    at 09:10 Brisbane was 0.1h, 0.1h, 0.1h and 0.3h old — the 0.3h being 27/08,
    when GitHub fired the morning slot 54 minutes late. The overnight gap a
    genuinely dead pipeline produces is ~13h and climbing. Six hours sits an
    order of magnitude above the healthy case and well under the failed one, so
    it neither cries wolf over a late build nor misses a stopped one.

    Four hours was the first attempt. It is enough today, but the backtest put
    the worst historical window at 4.1h — from August days when this ran once
    daily rather than hourly — and a threshold that holds only while nobody
    loosens the cron is a trap laid for whoever loosens it.
    """
    rows = sb.rpc('excel_datasets', {}) or []
    problems = []

    print(f'datasets registered ... {len(rows)}')
    print(f'build must be under ... {max_build_h}h old')
    print(f'data must be under .... {max_data_h}h old')
    print()

    # No datasets at all is not health, it is an empty room. A check that goes
    # green while watching nothing manufactures confidence.
    if not rows:
        print('NO DATASETS FOUND — this check is watching nothing.')
        print('  Either the schema is not deployed or no build has ever run.')
        return ['no datasets registered']

    for d in rows:
        slug = d.get('slug', '?')
        meta = d.get('meta') or {}
        build_h = _age_hours(d.get('built_at'))
        data_h = _age_hours(meta.get('data_at'))
        bad = []

        if build_h is None:
            bad.append('never built')
        elif build_h > max_build_h:
            bad.append(f'last build {build_h:.1f}h ago')

        # data_at is what the workbook stamp should be showing the user. A
        # fresh build over a frozen mirror is exactly what this catches.
        if data_h is None:
            bad.append('no data_at recorded')
        elif data_h > max_data_h:
            bad.append(f'data {data_h:.1f}h old')

        if not d.get('source_ok', True):
            bad.append('source_ok = false')
        if not d.get('row_count'):
            bad.append('0 rows')

        shown_build = '    -' if build_h is None else f'{build_h:5.1f}'
        shown_data = '    -' if data_h is None else f'{data_h:5.1f}'
        print(f'  {"FAIL" if bad else "ok  "} {slug:<16} '
              f'built {shown_build}h ago   data {shown_data}h old   '
              f'{d.get("row_count") or 0:,} rows')
        for b in bad:
            print(f'         {b}')
        if bad:
            problems.append(f'{slug}: ' + '; '.join(bad))

    return problems


def check_push_bindings(sb, max_minutes):
    """The retired push model, kept as a regression guard.

    A binding switched back on is a real fault: it means a machine may be
    writing values into a workbook that now fetches its own, and the two models
    silently overwrite each other. Says nothing while nothing is enabled.
    """
    on_disk = pivot.list_bindings()
    try:
        enabled = sb.rpc('excel_delivery_expected_count', {})
        rows = sb.rpc('excel_delivery_heartbeat',
                      {'p_max_business_minutes': max_minutes}) or []
    except SystemExit as e:
        if 'PGRST202' in str(e):
            print('note: db/004_delivery_heartbeat.sql is not deployed; '
                  'push-model check skipped.')
            return []
        raise

    if not enabled:
        print(f'push bindings .......... 0 of {len(on_disk)} enabled '
              '(delivery machine retired — workbooks pull via Power Query)')
        return []

    print(f'push bindings .......... {enabled} STILL ENABLED')
    print('  The delivery machine was retired in favour of Power Query. A')
    print('  binding switched on here means something may still be writing')
    print('  values into a workbook that now pulls its own.')
    for r in rows:
        print(f"    {r['slug']}: {r['problem']}")
    return [f'{enabled} push binding(s) still enabled']


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--max-build-hours', type=float, default=6.0,
                    help='hours a dataset may go without a rebuild (default 6)')
    ap.add_argument('--max-data-hours', type=float, default=6.0,
                    help='hours the underlying mirror may be stale (default 6)')
    ap.add_argument('--max-minutes', type=int, default=1620,
                    help='business minutes for the retired push-model check')
    ap.add_argument('--warn-only', action='store_true')
    args = ap.parse_args()

    sb = supabase.Client(schema='public')

    problems = check_datasets(sb, args.max_build_hours, args.max_data_hours)
    print()
    problems += check_push_bindings(sb, args.max_minutes)
    print()

    if not problems:
        print('OK — every dataset is fresh and nothing is pushing.')
        return 0

    print(f'{len(problems)} problem(s):')
    for p in problems:
        print(f'  - {p}')
    print()
    print('What this does NOT prove: that any workbook shows these numbers. A')
    print('workbook only updates when someone opens it and Excel refreshes the')
    print('query. This checks the source is worth pulling, not that it was.')
    return 0 if args.warn_only else 1


if __name__ == '__main__':
    sys.exit(main())
