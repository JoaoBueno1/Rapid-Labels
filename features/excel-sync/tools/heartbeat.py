"""Did the delivery machine actually deliver? Asked from somewhere else.

Every other guard in this project runs ON the Windows PC that writes the
workbooks, so they all share one blind spot: if that PC is off, asleep, logged
out, or the scheduled task was disabled, nothing runs and therefore nothing
complains. A dead machine and a quiet night look identical from the inside.

This runs in GitHub Actions. It reads rows only the delivery machine can write,
and exits non-zero when something is wrong — which is the whole notification
mechanism. Actions emails a failed workflow to the repo owner and pushes it to
the GitHub mobile app. That is the only push channel this estate has, it needs
no new secret, and it lands in a real inbox.

    python tools/heartbeat.py                 # exit 1 if anything is stale
    python tools/heartbeat.py --max-minutes 2880
    python tools/heartbeat.py --warn-only     # report, always exit 0

Needs SUPABASE_URL and SUPABASE_SERVICE_KEY, like everything else here.
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from engine import pivot, supabase                          # noqa: E402

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding='utf-8', errors='replace')
    except (AttributeError, ValueError):
        pass


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--max-minutes', type=int, default=1620,
                    help='business minutes a successful delivery may be stale '
                         '(default 1620 = one daily cycle plus three hours)')
    ap.add_argument('--warn-only', action='store_true')
    args = ap.parse_args()

    sb = supabase.Client(schema='public')
    on_disk = pivot.list_bindings()

    try:
        enabled = sb.rpc('excel_delivery_expected_count', {})
        rows = sb.rpc('excel_delivery_heartbeat',
                      {'p_max_business_minutes': args.max_minutes}) or []
    except SystemExit as e:
        if 'PGRST202' in str(e):
            print('BLOCKED — db/004_delivery_heartbeat.sql is not deployed.')
            print('  Paste it into the Supabase SQL editor; nothing can be checked until then.')
            return 1
        raise

    print(f'bindings in git ....... {len(on_disk)}')
    print(f'bindings enabled ...... {enabled}')
    print(f'staleness threshold ... {args.max_minutes} business minutes '
          f'({args.max_minutes / 60:.0f}h of working time)')
    print()

    # Nothing enabled is not health, it is silence. Said out loud rather than
    # reported as a pass, because a check that goes green when it is watching
    # nothing is worse than no check: it manufactures confidence.
    if not enabled:
        print('NOTHING IS ENABLED — this check is watching zero bindings.')
        print(f'  {len(on_disk)} binding file(s) exist in specs/bindings/, all disabled.')
        print('  That is correct before go-live. After go-live it means the')
        print('  heartbeat is green for the same reason a switched-off smoke')
        print('  alarm is quiet.')
        return 0 if args.warn_only else 0

    if enabled < len(on_disk):
        print(f'note: {len(on_disk) - enabled} binding(s) in git are still disabled. '
              'Deliberate during a staged rollout; worth a look otherwise.')
        print()

    if not rows:
        print(f'OK — all {enabled} enabled binding(s) delivered within the threshold.')
        return 0

    print(f'{len(rows)} of {enabled} binding(s) have a problem:')
    print()
    for r in rows:
        print(f"  {r['slug']}")
        print(f"      {r['problem']}")
        if r.get('last_ok'):
            print(f"      last success {str(r['last_ok'])[:19]} "
                  f"({r.get('business_minutes')} business minutes ago)")
        else:
            print('      no successful delivery on record')
        if r.get('last_status'):
            print(f"      last run ended: {r['last_status']}")
        if r.get('last_error'):
            print(f"      {str(r['last_error'])[:200]}")
        print()

    print('What this does NOT prove either way: it reads rows the delivery')
    print('machine wrote about itself. A success row means a process ran and')
    print('claimed to write — not that OneDrive uploaded it, nor that the')
    print('numbers underneath were fresh.')
    return 0 if args.warn_only else 1


if __name__ == '__main__':
    sys.exit(main())
