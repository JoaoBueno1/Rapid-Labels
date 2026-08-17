"""How is the trial going? One screen, no log reading.

The trial exists to answer questions the rehearsals cannot, because they only
happen over days and with other people in the files:

  does a run ever get refused, and why      a header gate firing means somebody
                                            inserted a column, which is the
                                            failure this project most needs to
                                            survive
  does 07:00 ever collide with a person     a workbook open in Excel makes the
                                            local transport refuse
  do the row counts stay sane               a branch that quietly halves is a
                                            dataset problem, not a delivery one

Reads the run logs in out/logs/ and the binding state in Supabase. Writes
nothing anywhere.

    python tools/trial_status.py
    python tools/trial_status.py --days 14
"""
import argparse
import collections
import datetime
import os
import re
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding='utf-8', errors='replace')
    except (AttributeError, ValueError):
        pass

LOGDIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'out', 'logs'))

RUN = re.compile(r'^ run started (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})')
TARGET = re.compile(r'^ target:\s+(.*)$')
BINDING = re.compile(r'^([a-z][a-z0-9-]+) → (.+?) / (.+)$')
OK = re.compile(r'^\s+OK — (\d+) rows')
REFUSE = re.compile(r'^\s+REFUSE — (.*)$')
SUMMARY = re.compile(r'^ exit (\d+) \| (\d+) written \| (\d+) refused')


def parse_log(path):
    """One log file holds every run of that day, appended."""
    runs = []
    cur = None
    binding = None
    with open(path, encoding='utf-8', errors='replace') as fh:
        for line in fh:
            line = line.rstrip('\n')
            m = RUN.match(line)
            if m:
                cur = {'started': m.group(1), 'target': '?', 'written': 0,
                       'refused': [], 'rows': {}, 'exit': None}
                runs.append(cur)
                continue
            if cur is None:
                continue
            m = TARGET.match(line)
            if m:
                cur['target'] = m.group(1).strip()
                continue
            m = BINDING.match(line)
            if m:
                binding = m.group(1)
                continue
            m = OK.match(line)
            if m and binding:
                cur['rows'][binding] = int(m.group(1))
                cur['written'] += 1
                continue
            m = REFUSE.match(line)
            if m:
                cur['refused'].append((binding or '?', m.group(1).strip()))
                continue
            m = SUMMARY.match(line)
            if m:
                cur['exit'] = int(m.group(1))
    return runs


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--days', type=int, default=10)
    args = ap.parse_args()

    if not os.path.isdir(LOGDIR):
        raise SystemExit(f'no logs yet: {LOGDIR}')
    files = sorted(f for f in os.listdir(LOGDIR) if f.endswith('.log'))[-args.days:]
    if not files:
        raise SystemExit(f'no logs in {LOGDIR}')

    all_runs = []
    for f in files:
        all_runs.extend(parse_log(os.path.join(LOGDIR, f)))

    print(f'{len(all_runs)} run(s) across {len(files)} day(s)\n')
    print(f"{'started':<20}{'target':<8}{'written':>8}{'refused':>9}{'exit':>6}")
    print('-' * 53)
    for r in all_runs:
        tgt = 'TEST' if r['target'].startswith('TEST') else 'LIVE'
        flag = '' if (r['exit'] == 0 and not r['refused']) else '   <<<'
        print(f"{r['started']:<20}{tgt:<8}{r['written']:>8}{len(r['refused']):>9}"
              f"{str(r['exit']):>6}{flag}")

    refusals = [(r['started'], b, why) for r in all_runs for b, why in r['refused']]
    if refusals:
        print(f'\nREFUSALS ({len(refusals)}) — each one is the point of the trial:')
        for when, b, why in refusals:
            print(f'  {when}  {b}\n      {why}')
    else:
        print('\nNo refusal in the whole trial.')
        print('  Read that carefully: it means nothing has tested the header gate')
        print('  yet. The gate is unproven in the field, not proven safe.')

    # A branch that quietly halves is a dataset problem wearing delivery clothes.
    writes = [r for r in all_runs if r['written']]
    if len(writes) >= 2:
        print('\nROW COUNTS — last run vs the one before, per binding:')
        prev, last = writes[-2]['rows'], writes[-1]['rows']
        moved = []
        for b in sorted(set(prev) | set(last)):
            a, c = prev.get(b), last.get(b)
            if a is None or c is None or a == c:
                continue
            pct = 100.0 * (c - a) / a if a else 0.0
            moved.append((abs(pct), b, a, c, pct))
        if not moved:
            print('  every binding wrote the same number of rows.')
        for _, b, a, c, pct in sorted(moved, reverse=True):
            mark = '  <<< check' if abs(pct) >= 20 else ''
            print(f'  {b:<30}{a:>7} -> {c:<7} {pct:+6.1f}%{mark}')

    bad = [r for r in all_runs if r['exit'] not in (0, None) or r['refused']]
    print(f"\n{len(all_runs) - len(bad)} clean, {len(bad)} needing a look.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
