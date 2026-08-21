"""Monta as duas abas novas nos 6 arquivos de teste e mede o custo delas.

Mede o mesmo arquivo antes e depois, no mesmo dia e na mesma maquina: e o
unico jeito de a diferenca significar alguma coisa.
"""
import win32com.client as win32, os, sys, glob, json, time, shutil, subprocess, pywintypes

HERE = os.path.dirname(os.path.abspath(__file__))
TEST = os.path.expanduser('~/OneDrive - RapidLED/Desktop/Tests files')
BK = os.path.abspath(sorted(glob.glob(os.path.join(HERE, 'BACKUP_2*')))[0])
FILES = ['Brisbane Aug 26.xlsx', 'Cairns - Aug 26.xlsx', 'Coffs Harbour Aug 26.xlsx',
         'Melbourne Aug 26.xlsx', 'Sunshine Coast Aug 26.xlsx', 'Sydney Aug 26.xlsx']


def sh(cmd):
    r = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True, timeout=1800)
    return r.stdout.strip().splitlines()[-1] if r.stdout.strip() else (r.stderr or '')[-160:]


def measure(fn, tries=3):
    """RefreshAll cronometrado. Excel cai as vezes; tenta de novo."""
    for _ in range(tries):
        xl = win32.DispatchEx('Excel.Application')
        xl.Visible = False; xl.DisplayAlerts = False
        try:
            wb = xl.Workbooks.Open(os.path.join(TEST, fn), UpdateLinks=0)
            nq = wb.Queries.Count; nc = wb.Connections.Count
            t0 = time.time()
            wb.RefreshAll(); xl.CalculateUntilAsyncQueriesDone()
            dt = time.time() - t0
            try: wb.Close(False)
            except Exception: pass
            return dt, nq, nc
        except Exception:
            # O Excel cai de vez em quando e o objeto vira invalido: aparece
            # como AttributeError, nao como com_error. Pegar so com_error
            # derrubava a medicao inteira.
            pass
        finally:
            try: xl.Quit()
            except Exception: pass
            time.sleep(2)
    return None, None, None


def run(fn):
    shutil.copy2(os.path.join(BK, fn), os.path.join(TEST, fn))
    key = fn.split()[0]
    sh([sys.executable, 'pq_migrate.py', '--only', key])
    size0 = os.path.getsize(os.path.join(TEST, fn))
    t0, q0, c0 = measure(fn)

    sh([sys.executable, 'add_stock_data.py', fn])
    sh([sys.executable, 'add_restock.py', fn])
    size1 = os.path.getsize(os.path.join(TEST, fn))
    t1, q1, c1 = measure(fn)

    return dict(file=fn, size0=size0, size1=size1, t0=t0, t1=t1,
                q0=q0, c0=c0, q1=q1, c1=c1)


if __name__ == '__main__':
    out = []
    for fn in (sys.argv[1:] or FILES):
        r = run(fn)
        out.append(r)
        print('  %-28s %5.1fs -> %5.1fs   %5.2f MB -> %5.2f MB   %s/%s consultas'
              % (r['file'], r['t0'] or -1, r['t1'] or -1,
                 r['size0']/1e6, r['size1']/1e6, r['q0'], r['q1']), flush=True)
    ok = [r for r in out if r['t0'] and r['t1']]
    if ok:
        print('\n  MEDIA  antes %.1fs   depois %.1fs   custo das 2 abas +%.1fs'
              % (sum(r['t0'] for r in ok)/len(ok), sum(r['t1'] for r in ok)/len(ok),
                 sum(r['t1']-r['t0'] for r in ok)/len(ok)))
        print('  TAMANHO antes %.2f MB  depois %.2f MB  (+%.0f%%)'
              % (sum(r['size0'] for r in ok)/len(ok)/1e6,
                 sum(r['size1'] for r in ok)/len(ok)/1e6,
                 100*(sum(r['size1'] for r in ok)/sum(r['size0'] for r in ok)-1)))
    json.dump(out, open(os.path.join(HERE, 'bench.json'), 'w'), indent=1)
