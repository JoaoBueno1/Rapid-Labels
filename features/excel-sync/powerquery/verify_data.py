"""Confere cada aba contra a fonte, celula a celula, e compara a contagem de
formulas com erro contra o backup -- que e o unico jeito de provar que os
~3.826 PROCV sobreviveram a troca."""
import win32com.client as win32, os, sys, re, json, glob, urllib.request, urllib.parse
import pywintypes
from openpyxl.utils import get_column_letter as CL, column_index_from_string as CI

DIR = os.path.expanduser('~/OneDrive - RapidLED/Desktop/Tests files')
env = {}
for line in open(os.path.expanduser('~/Rapid-Labels/.env'), encoding='utf8'):
    m = re.match(r'\s*([A-Z0-9_]+)\s*=\s*(.*)', line)
    if m: env[m.group(1)] = m.group(2).strip().strip('"').strip("'")
URL, KEY = env['SUPABASE_URL'], env['SUPABASE_ANON_KEY']
xlUp, xlFormulas, xlErrors = -4162, -4123, 16

def fetch(ds, locs):
    f = 'in.(' + ','.join('"%s"' % l for l in locs) + ')'
    out, off = [], 0
    while True:
        q = urllib.parse.urlencode({'p_dataset':ds,'location':f,'limit':'1000','offset':str(off)})
        r = urllib.request.Request('%s/rest/v1/rpc/excel_dataset_rows?%s' % (URL, q))
        r.add_header('apikey', KEY); r.add_header('Authorization', 'Bearer ' + KEY)
        d = json.load(urllib.request.urlopen(r, timeout=180))
        if not d: return out
        out += d; off += 1000

def reference(b):
    """Reimplementa engine/flat.py: soma por SKU, ordena case-insensitive."""
    acc = {}
    for r in fetch(b['dataset'], b['locs']):
        a = acc.setdefault(r['sku'], {})
        for k, v in (r.get('metrics') or {}).items():
            a[k] = a.get(k, 0.0) + (0.0 if v in (None, '') else float(v))
    grid = []
    for sku in sorted(acc, key=lambda s: (str(s).lower(), str(s))):
        row = [sku]
        for c in b['cols'][1:]:
            if c[2]: row.append('')
            else:
                v = acc[sku].get(c[0], 0.0)
                row.append(round(v, c[3]) if c[3] is not None else v)
        grid.append(row)
    return grid

def split(a):
    m = re.match(r'^([A-Z]+)(\d+)$', a.upper()); return CI(m.group(1)), int(m.group(2))

def err_counts(xl, path):
    """Formulas com erro por aba. Comparavel entre backup e migrado."""
    wb = xl.Workbooks.Open(path, UpdateLinks=0, ReadOnly=True)
    out = {}
    for ws in wb.Worksheets:
        try: ws.UsedRange.SpecialCells(xlFormulas).Count
        except pywintypes.com_error: continue
        try: bad = ws.UsedRange.SpecialCells(xlFormulas, xlErrors).Count
        except pywintypes.com_error: bad = 0
        out[ws.Name] = bad
    wb.Close(False)
    return out

def check(xl, fn, bindings, bk):
    print('\n=== %s ===' % fn)
    wb = xl.Workbooks.Open(os.path.join(DIR, fn), UpdateLinks=0)
    allok = True
    for b in bindings:
        ws = wb.Worksheets(b['sheet'])
        c0, r0 = split(b['anchor']); n = len(b['cols'])
        ref = reference(b)
        last = ws.Cells(ws.Rows.Count, c0).End(xlUp).Row
        got = [list(r) for r in
               ws.Range(ws.Cells(r0, c0), ws.Cells(last, c0 + n - 1)).Value]
        diffs = []
        if len(got) != len(ref):
            diffs.append('contagem %d vs %d' % (len(got), len(ref)))
        else:
            for i, (g, e) in enumerate(zip(got, ref)):
                for j in range(n):
                    gv, ev = g[j], e[j]
                    try: same = abs(float(gv or 0) - float(ev or 0)) < 1e-6
                    except (TypeError, ValueError): same = str(gv or '') == str(ev or '')
                    if not same:
                        diffs.append('linha %d col %s: excel=%r fonte=%r'
                                     % (r0 + i, CL(c0 + j), gv, ev))
        ok = not diffs; allok &= ok
        sc, _ = split(b['cell'])
        print('  %-11s %5d linhas  %s' % (b['sheet'], len(got),
                                          'IDENTICO' if ok else 'DIVERGE'))
        for d in diffs[:3]: print('        %s' % d)
        print('        %s' % str(ws.Cells(1, sc).Value)[:96])
    wb.Close(False)

    before = err_counts(xl, os.path.join(bk, fn))
    after  = err_counts(xl, os.path.join(DIR, fn))
    worse  = {s: (before.get(s, 0), after.get(s, 0))
              for s in set(before) | set(after) if before.get(s, 0) != after.get(s, 0)}
    for s, (a, c) in list(worse.items())[:5]:
        print('        formulas com erro em %r: %d -> %d' % (s, a, c))
    print('        %d abas com formula, %d com contagem de erro alterada'
          % (len(before), len(worse)))
    return allok, len(worse)

if __name__ == '__main__':
    ALL = [b for b in json.load(open('/tmp/bindings.json'))
           if 'Hobart' not in b['file']]
    names = sorted({b['file'] for b in ALL})
    want = sys.argv[1:]
    files = [f for f in names if not want or any(t.lower() in f.lower() for t in want)]
    bk = os.path.abspath(sorted(glob.glob('BACKUP_*'))[-1])
    grand = []
    for fn in files:
        xl = win32.DispatchEx('Excel.Application')
        xl.Visible = False; xl.DisplayAlerts = False
        try:
            grand.append((fn,) + check(xl, fn, [b for b in ALL if b['file'] == fn], bk))
        finally:
            try: xl.Quit()
            except Exception: pass
    print('\n' + '=' * 66)
    for fn, ok, w in grand:
        print('  %-28s %-10s abas com erro alterado: %d'
              % (fn, 'IDENTICO' if ok else 'DIVERGE', w))
    print('  %d/%d arquivos conferem com a fonte' % (sum(1 for _, o, _ in grand if o), len(grand)))
