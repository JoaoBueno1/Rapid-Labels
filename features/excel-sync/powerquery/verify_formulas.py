"""Conta formulas com erro antes/depois nos arquivos REAIS."""
import win32com.client as win32, os, glob, sys, pywintypes
REAL = 'C:/Users/JoaoMarcos/RapidLED/WorkDocs - Rapid LED - Data/Inventory Management/Inventory Stock Orders'
BK = os.path.abspath(sorted(glob.glob('BACKUP_REAL_*'))[-1])
xlFormulas, xlErrors = -4123, 16
def counts(xl, p):
    wb = xl.Workbooks.Open(p, UpdateLinks=0, ReadOnly=True)
    out = {}
    for ws in wb.Worksheets:
        try: ws.UsedRange.SpecialCells(xlFormulas).Count
        except pywintypes.com_error: continue
        try: out[ws.Name] = ws.UsedRange.SpecialCells(xlFormulas, xlErrors).Count
        except pywintypes.com_error: out[ws.Name] = 0
    wb.Close(False); return out
for fn in sys.argv[1:]:
    xl = win32.DispatchEx('Excel.Application'); xl.Visible=False; xl.DisplayAlerts=False
    try:
        a = counts(xl, os.path.join(BK, fn))
        b = counts(xl, os.path.join(REAL, fn))
        worse = {s:(a.get(s,0), b.get(s,0)) for s in set(a)|set(b) if a.get(s,0)!=b.get(s,0)}
        print(f'  {fn:<26} {len(a)} abas com formula | erros totais {sum(a.values())} -> '
              f'{sum(b.values())} | abas alteradas: {len(worse)}')
        for s,(x,y) in list(worse.items())[:6]: print(f'       {s}: {x} -> {y}')
    finally:
        try: xl.Quit()
        except Exception: pass
