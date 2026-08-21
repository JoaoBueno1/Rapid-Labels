"""Cria a aba Restock Suggestion, uma por filial."""
import win32com.client as win32, os, sys, json, time, shutil, tempfile, argparse, pywintypes
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from generate_restock import m_restock, SUFFIX

TEST = os.path.expanduser('~/OneDrive - RapidLED/Desktop/Tests files')
REAL = ('C:/Users/JoaoMarcos/RapidLED/WorkDocs - Rapid LED - Data/'
        'Inventory Management/Inventory Stock Orders')
SHEET, QUERY, SYNC = 'Restock Suggestion', 'Restock_Suggestion', '_Sync'
NCOL = 5
xlUp, xlExpression, xlCmdSql = -4162, 2, 2
def bgr(r, g, b): return r + g * 256 + b * 65536
GREEN, GREEN_TX = bgr(198, 239, 206), bgr(0, 97, 0)
RED,   RED_TX   = bgr(255, 199, 206), bgr(156, 0, 6)
AMBER, AMBER_TX = bgr(255, 235, 156), bgr(156, 101, 0)


def branch_of(fn):
    """A filial e a location da aba de estoque da propria filial."""
    B = json.load(open('/tmp/bindings.json'))
    for b in B:
        if b['file'] == fn and b['dataset'] == 'stock-level':
            loc = b['locs'][0]
            if loc in SUFFIX:
                return loc
    raise SystemExit('nao achei a filial de %s' % fn)


def drop_query(wb, name):
    """Apaga a consulta E toda conexao que aponte para ela.

    ListObjects.Add batiza a conexao de "Connection<N>", nao com o nome da
    consulta. Apagar so por nome deixava uma conexao orfa a cada reconstrucao,
    e cada uma delas REEXECUTA a consulta no Atualizar Tudo: o Sydney de teste
    chegou a 15 conexoes para 6 consultas e levava 32s achando que travou.
    """
    import pywintypes
    for i in range(wb.Connections.Count, 0, -1):
        c = wb.Connections.Item(i)
        try:
            s = c.OLEDBConnection.Connection
        except pywintypes.com_error:
            s = ''
        if ('Location=%s;' % name) in str(s) or c.Name in (name, 'Query - ' + name):
            try: c.Delete()
            except pywintypes.com_error: pass
    for i in range(wb.Queries.Count, 0, -1):
        if wb.Queries.Item(i).Name == name:
            try: wb.Queries.Item(i).Delete()
            except pywintypes.com_error: pass

def build(path, branch):
    tmp = os.path.join(tempfile.gettempdir(), 'rs_' + os.path.basename(path))
    shutil.copy2(path, tmp)
    xl = win32.DispatchEx('Excel.Application')
    xl.Visible = False; xl.DisplayAlerts = False
    try:
        wb = xl.Workbooks.Open(tmp, UpdateLinks=0)
        # Sem isto o Formula Firewall recusa a consulta: ela junta o
        # branch_avg_monthly_sales (schema public) com o stock_snapshot
        # (cin7_mirror), e o Power Query trata como fontes distintas.
        try: wb.Queries.FastCombine = True
        except pywintypes.com_error: pass
        drop_query(wb, QUERY)
        try: wb.Worksheets(SHEET).Delete()
        except pywintypes.com_error: pass

        try:    ws = wb.Worksheets.Add(Before=wb.Worksheets(SYNC))
        except pywintypes.com_error:
            ws = wb.Worksheets.Add(After=wb.Worksheets(wb.Worksheets.Count))
        ws.Name = SHEET

        wb.Queries.Add(QUERY, m_restock(branch))
        t0 = time.time()
        lo = ws.ListObjects.Add(
            0, 'OLEDB;Provider=Microsoft.Mashup.OleDb.1;Data Source=$Workbook$;'
               'Location=%s;Extended Properties=""' % QUERY,
            True, 1, ws.Range('A1'))
        qt = lo.QueryTable
        qt.CommandType = xlCmdSql
        qt.CommandText = 'SELECT * FROM [%s]' % QUERY
        qt.BackgroundQuery = False
        qt.PreserveFormatting = True
        qt.Refresh(False)
        dt = time.time() - t0
        lo.Name = 'tbl_Restock_Suggestion'
        # Sem estilo de tabela: o azul listrado do Excel compete com o unico
        # sinal que importa aqui, que e o vermelho do Main sem estoque.
        try:
            lo.TableStyle = ''
            lo.ShowAutoFilter = False
        except pywintypes.com_error: pass
        n = ws.Cells(ws.Rows.Count, 1).End(xlUp).Row - 1

        # Vermelho quando Main + Gateway (E) nao cobre a sugestao (B).
        # Nao adianta pedir o que a matriz nao tem, e essa e a unica cor da aba.
        rng = ws.Range(ws.Cells(2, 5), ws.Cells(100000, 5))
        rng.FormatConditions.Delete()
        fc = rng.FormatConditions.Add(xlExpression, None, '=AND($A2<>"",$E2<$B2)')
        fc.Interior.Color = RED
        fc.Font.Color = RED_TX

        sc = NCOL + 2
        cnt = 'COUNTA(A2:A1048576)'
        ws.Cells(1, sc).Formula = (
            '="Updated "&%s!$A$2&" - "&TEXT(%s,"#,##0")&" to restock"'
            '&IF(%s!$B$2=TODAY(),"","   (!) Press Data > Refresh All")'
            % (SYNC, cnt, SYNC))
        rows = [('Refreshed', '=%s!$A$2' % SYNC),
                ('Data from', '=%s!$C$2' % SYNC),
                ('Branch',    branch),
                ('Rule',      'cover under 21 days, nothing in transit'),
                ('Lines',     '=' + cnt),
                ('Source',    'Database connected')]
        for i, (lab, val) in enumerate(rows):
            ws.Cells(3 + i, sc).Value = lab
            c = ws.Cells(3 + i, sc + 1)
            if str(val).startswith('='): c.Formula = val
            else: c.Value = val
            if lab == 'Lines': c.NumberFormat = '#,##0'
        ws.Cells(3, sc).Resize(len(rows), 1).Font.Bold = True
        cell = ws.Cells(1, sc); cell.FormatConditions.Delete()
        for expr, fill, tx in ((f'={SYNC}!$B$2=TODAY()',  GREEN, GREEN_TX),
                               (f'={SYNC}!$B$2<>TODAY()', AMBER, AMBER_TX)):
            fc = cell.FormatConditions.Add(xlExpression, None, expr)
            fc.Interior.Color = fill; fc.Font.Color = tx
        cell.Font.Bold = True
        ws.Range(ws.Cells(1, 1), ws.Cells(1, NCOL)).Font.Bold = True
        ws.Range(ws.Cells(1, 1), ws.Cells(1, NCOL)).EntireColumn.AutoFit()
        for c in range(1, NCOL + 1):
            if ws.Columns(c).ColumnWidth > 46: ws.Columns(c).ColumnWidth = 46
        print('  %-28s %s: %d linhas — %.1fs' % (os.path.basename(path), branch, n, dt))
        wb.Save(); wb.Close(False)
    finally:
        try: xl.Quit()
        except Exception: pass
    shutil.copy2(tmp, path); os.remove(tmp)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('file'); ap.add_argument('--real', action='store_true')
    a = ap.parse_args()
    build(os.path.join(REAL if a.real else TEST, a.file), branch_of(a.file))
