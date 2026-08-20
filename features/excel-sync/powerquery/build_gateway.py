"""Gateway Driver: conserta o stock check, liga o SOH Dear e cria o Stock Data."""
import win32com.client as win32, os, sys, time, shutil, tempfile, pywintypes
sys.path.insert(0, '.')
from generate_gateway_soh import m_gateway_soh
from generate_stock_data import m_stock_data, COLS as SD_COLS

SRC = ('C:/Users/JoaoMarcos/RapidLED/Inventory Management - Documents/'
       'Gateway/Gateway Driver Aug 26.xlsx')
SYNC = '_Sync'
xlUp, xlExpression, xlCmdSql, xlSheetHidden = -4162, 2, 2, 0
def bgr(r,g,b): return r + g*256 + b*65536
GREEN, GREEN_TX = bgr(198,239,206), bgr(0,97,0)
AMBER, AMBER_TX = bgr(255,235,156), bgr(156,101,0)

def drop_query(wb, name):
    for i in range(wb.Connections.Count, 0, -1):
        c = wb.Connections.Item(i)
        try: s = str(c.OLEDBConnection.Connection)
        except pywintypes.com_error: s = ''
        if ('Location=%s;' % name) in s or c.Name in (name, 'Query - ' + name):
            try: c.Delete()
            except pywintypes.com_error: pass
    for i in range(wb.Queries.Count, 0, -1):
        if wb.Queries.Item(i).Name == name:
            try: wb.Queries.Item(i).Delete()
            except pywintypes.com_error: pass

def load(wb, ws, name, m, col, row):
    drop_query(wb, name)
    wb.Queries.Add(name, m)
    lo = ws.ListObjects.Add(
        0, 'OLEDB;Provider=Microsoft.Mashup.OleDb.1;Data Source=$Workbook$;'
           'Location=%s;Extended Properties=""' % name, True, 1, ws.Cells(row, col))
    qt = lo.QueryTable
    qt.CommandType = xlCmdSql
    qt.CommandText = 'SELECT * FROM [%s]' % name
    qt.BackgroundQuery = False
    qt.AdjustColumnWidth = False
    qt.PreserveFormatting = True
    qt.Refresh(False)
    lo.Name = 'tbl_' + name
    try:
        lo.TableStyle = ''
        lo.ShowAutoFilter = False
    except pywintypes.com_error: pass
    return lo

def stamp(ws, sc, first_row, key_col, linhas):
    cnt = 'COUNTA(%s%d:%s1048576)' % (key_col, first_row, key_col)
    ws.Cells(1, sc).Formula = (
        '="Updated "&%s!$A$2&" - "&TEXT(%s,"#,##0")&" %s"'
        '&IF(%s!$B$2=TODAY(),"","   (!) Press Data > Refresh All")'
        % (SYNC, cnt, linhas, SYNC))
    for i, (lab, val) in enumerate([('Refreshed', '=%s!$A$2' % SYNC),
                                    ('Data from', '=%s!$H$2' % SYNC),
                                    ('Rows',      '=' + cnt),
                                    ('Source',    'Database connected')]):
        ws.Cells(3+i, sc).Value = lab
        c = ws.Cells(3+i, sc+1)
        if str(val).startswith('='): c.Formula = val
        else: c.Value = val
        if lab == 'Rows': c.NumberFormat = '#,##0'
    ws.Cells(3, sc).Resize(4,1).Font.Bold = True
    cell = ws.Cells(1, sc); cell.FormatConditions.Delete()
    for expr, fill, tx in ((f'={SYNC}!$B$2=TODAY()',  GREEN, GREEN_TX),
                           (f'={SYNC}!$B$2<>TODAY()', AMBER, AMBER_TX)):
        fc = cell.FormatConditions.Add(xlExpression, None, expr)
        fc.Interior.Color = fill; fc.Font.Color = tx
    cell.Font.Bold = True

tmp = os.path.join(tempfile.gettempdir(), 'gw_' + os.path.basename(SRC))
shutil.copy2(SRC, tmp)
xl = win32.DispatchEx('Excel.Application'); xl.Visible=False; xl.DisplayAlerts=False
try:
    wb = xl.Workbooks.Open(tmp, UpdateLinks=0)
    try: wb.Queries.FastCombine = True
    except pywintypes.com_error: pass

    # ── 1) conserta a aba stock check ─────────────────────────────────────
    # A busca comecava na coluna B (Unit, sempre "Item") procurando um SKU:
    # nunca achava, e as 522 celulas viviam em #N/A, matando a VARIANCE junto.
    # SUMIF em vez de VLOOKUP: e o padrao que ja funciona na DAILY STOCK
    # REPORT deste mesmo arquivo, devolve 0 (verdade) em vez de #N/A quando o
    # SKU nao esta la, e soma se ele aparecer em mais de uma linha.
    sc_ws = wb.Worksheets('stock check')
    n_fix = 0
    for r in range(2, 600):
        if sc_ws.Cells(r, 2).Value in (None, ''): continue
        f = sc_ws.Cells(r, 3).Formula
        if isinstance(f, str) and "'SOH Dear'!B:F" in f:
            sc_ws.Cells(r, 3).Formula = (
                "=SUMIF('SOH Dear'!$A:$A,B%d,'SOH Dear'!$C:$C)" % r)
            n_fix += 1
    print('  stock check: %d formulas corrigidas' % n_fix)

    # ── 2) a aba _Sync ────────────────────────────────────────────────────
    import pq_m
    try: wb.Worksheets(SYNC).Delete()
    except pywintypes.com_error: pass
    sy = wb.Worksheets.Add(After=wb.Worksheets(wb.Worksheets.Count)); sy.Name = SYNC
    load(wb, sy, 'Sync_Status', pq_m.m_status(), 1, 1)
    sy.Visible = xlSheetHidden

    # ── 3) SOH Dear ───────────────────────────────────────────────────────
    ws = wb.Worksheets('SOH Dear')
    keep = [ws.Columns(c).ColumnWidth for c in range(1, 20)]
    for i in range(ws.ListObjects.Count, 0, -1): ws.ListObjects(i).Delete()
    for i in range(ws.QueryTables.Count, 0, -1): ws.QueryTables(i).Delete()
    last = ws.Cells(ws.Rows.Count, 1).End(xlUp).Row
    ws.Range(ws.Cells(2,1), ws.Cells(max(last,2), 9)).ClearContents()
    t0 = time.time()
    lo = load(wb, ws, 'SOH_Gateway', m_gateway_soh(), 1, 2)
    ws.Range(ws.Cells(3,1), ws.Cells(9000,1)).NumberFormat = '@'
    ws.Range(ws.Cells(3,2), ws.Cells(9000,9)).NumberFormat = 'General'
    stamp(ws, 11, 3, 'A', 'products')
    for c, w in enumerate(keep, start=1):
        if ws.Columns(c).ColumnWidth != w: ws.Columns(c).ColumnWidth = w
    print('  SOH Dear   : %d linhas  %.1fs  %s' % (lo.ListRows.Count, time.time()-t0,
                                                   lo.Range.Address))

    # ── 4) Stock Data ─────────────────────────────────────────────────────
    try: wb.Worksheets('Stock Data').Delete()
    except pywintypes.com_error: pass
    sd = wb.Worksheets.Add(Before=wb.Worksheets(SYNC)); sd.Name = 'Stock Data'
    t0 = time.time()
    lo2 = load(wb, sd, 'Stock_Data', m_stock_data(), 1, 1)
    for i, (_, h, t) in enumerate(SD_COLS, start=1):
        if t == 'date':
            sd.Range(sd.Cells(2,i), sd.Cells(1048576,i)).NumberFormat = 'dd mmm yyyy'
    n = len(SD_COLS)
    stamp(sd, n + 2, 2, 'A', 'products')
    sd.Range(sd.Cells(1,1), sd.Cells(1,n)).Font.Bold = True
    sd.Range(sd.Cells(1,1), sd.Cells(1,n)).EntireColumn.AutoFit()
    for c in range(1, n+1):
        if sd.Columns(c).ColumnWidth > 42: sd.Columns(c).ColumnWidth = 42
    print('  Stock Data : %d linhas  %.1fs' % (lo2.ListRows.Count, time.time()-t0))

    wb.Save(); wb.Close(False)
finally:
    try: xl.Quit()
    except Exception: pass
shutil.copy2(tmp, SRC); os.remove(tmp)
print('  gravado em', SRC)
