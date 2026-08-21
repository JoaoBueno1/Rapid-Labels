"""Converte as abas de dados para Power Query, preservando o layout.

O que NAO muda: as ~3.826 formulas PROCV (todas por coluna inteira), as abas de
pedido, as cores, os cabecalhos. O que muda: os dados passam a ser puxados pelo
proprio arquivo quando alguem clica Atualizar, em vez de escritos de fora.
"""
import win32com.client as win32, os, sys, re, json, time, argparse, pywintypes
from openpyxl.utils import get_column_letter as CL, column_index_from_string as CI
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import generate_m as pq_m

DIR  = os.path.expanduser('~/OneDrive - RapidLED/Desktop/Tests files')
REAL = 'C:/Users/JoaoMarcos/RapidLED/WorkDocs - Rapid LED - Data/Inventory Management/Inventory Stock Orders'
SYNC = '_Sync'
xlSheetVisible, xlSheetHidden = -1, 0
xlUp, xlExpression, xlCmdSql = -4162, 2, 2

def bgr(r, g, b): return r + g*256 + b*65536
GREEN, GREEN_TX = bgr(198,239,206), bgr(0,97,0)
AMBER, AMBER_TX = bgr(255,235,156), bgr(156,101,0)

def split(a):
    m = re.match(r'^([A-Z]+)(\d+)$', a.upper()); return CI(m.group(1)), int(m.group(2))

def qname(sheet): return re.sub(r'[^A-Za-z0-9]+', '_', sheet).strip('_')

def drop(wb, name):
    for coll, attr in ((wb.Queries, 'Name'), (wb.Connections, 'Name')):
        for i in range(coll.Count, 0, -1):
            try:
                if coll.Item(i).Name in (name, 'Query - ' + name): coll.Item(i).Delete()
            except pywintypes.com_error: pass

def load(wb, ws, name, m, dest_col, dest_row):
    """Cria a consulta e a aterrissa como Tabela na celula pedida."""
    drop(wb, name)
    wb.Queries.Add(name, m)

    # ListObjects.Add(SourceType, Source, LinkSource, HasHeaders, Destination).
    # LinkSource TEM de ser True para fonte externa -- sem isso o Excel devolve
    # E_INVALIDARG, e QueryTables.Add cria um range legado sem Tabela, que o
    # Excel do navegador nao atualiza.
    lo = ws.ListObjects.Add(
        0,
        'OLEDB;Provider=Microsoft.Mashup.OleDb.1;Data Source=$Workbook$;'
        'Location=%s;Extended Properties=""' % name,
        True, 1, ws.Cells(dest_row, dest_col))
    qt = lo.QueryTable
    qt.CommandType = xlCmdSql
    qt.CommandText = 'SELECT * FROM [%s]' % name
    qt.BackgroundQuery = False
    qt.AdjustColumnWidth = False          # nao mexer nas larguras existentes
    qt.PreserveFormatting = True
    qt.Refresh(False)
    lo.Name = 'tbl_' + name
    try:
        lo.TableStyle = ''                # o estilo de tabela sobrescreveria as cores
        lo.ShowAutoFilter = False
    except pywintypes.com_error: pass
    return lo

def stamp(ws, b, hdr_row, key_col, is_sales):
    """Carimbo + bloco, em formulas -- para mudarem sozinhos no Refresh."""
    sc, _ = split(b['cell'])
    vc = sc + 1
    first = hdr_row + 1
    count = 'COUNTA(%s%d:%s1048576)' % (CL(key_col), first, CL(key_col))
    r0 = 2 if is_sales else 3             # nas Sales a linha 6 e o cabecalho

    ws.Cells(1, sc).Formula = (
        '="Updated "&%s!$A$2&" - "&TEXT(%s,"#,##0")&" products"'
        '&IF(%s!$B$2=TODAY(),"","   (!) Press Data > Refresh All")'
        % (SYNC, count, SYNC))

    lines = [('Refreshed', '=%s!$A$2' % SYNC)]
    if is_sales:
        lines += [('Data from',    '=%s!$D$2' % SYNC),
                  ('Sales period', '=%s!$E$2' % SYNC),
                  ('Products',     '=' + count)]
    else:
        lines += [('Data from', '=%s!$C$2' % SYNC),
                  ('Products',  '=' + count),
                  ('Source',    'Database connected')]
    for i, (lab, val) in enumerate(lines):
        ws.Cells(r0 + i, sc).Value = lab
        c = ws.Cells(r0 + i, vc)
        if str(val).startswith('='): c.Formula = val
        else: c.Value = val
        if lab == 'Products': c.NumberFormat = '#,##0'
    ws.Cells(r0, sc).Resize(len(lines), 1).Font.Bold = True

    # O sinal visual: verde = atualizado hoje, ambar = precisa apertar Atualizar.
    cell = ws.Cells(1, sc)
    cell.FormatConditions.Delete()
    for expr, fill, txt in ((f'={SYNC}!$B$2=TODAY()',  GREEN, GREEN_TX),
                            (f'={SYNC}!$B$2<>TODAY()', AMBER, AMBER_TX)):
        # (Type, Operator, Formula1) posicional com Operator=None e a UNICA
        # forma que o late binding do pywin32 aceita para xlExpression.
        fc = cell.FormatConditions.Add(xlExpression, None, expr)
        fc.Interior.Color = fill
        fc.Font.Color = txt
    cell.Font.Bold = True


def migrate(path, bindings, tabs, hide_sync=False):
    """Trabalha numa copia FORA do OneDrive e so devolve se tudo deu certo.

    Os arquivos ficam numa pasta sincronizada e o AutoSave do Excel esta ligado:
    na primeira tentativa uma falha no meio ficou gravada no arquivo real. Aqui
    o original so e tocado depois que as abas carregaram e o arquivo fechou.
    """
    import shutil, tempfile
    tmp = os.path.join(tempfile.gettempdir(), 'pqmig_' + os.path.basename(path))
    shutil.copy2(path, tmp)
    try:
        done = _migrate(tmp, bindings, tabs, hide_sync)
    except Exception:
        print('   (copia de trabalho preservada em %s)' % tmp)
        raise
    shutil.copy2(tmp, path)
    os.remove(tmp)
    return done


def _migrate(path, bindings, tabs, hide_sync=False):
    xl = win32.DispatchEx('Excel.Application')
    xl.Visible = False; xl.DisplayAlerts = False; xl.AskToUpdateLinks = False
    done = []
    try:
        wb = xl.Workbooks.Open(path, UpdateLinks=0)
        try: wb.Queries.FastCombine = True
        except pywintypes.com_error: pass

        # 1) A aba de status primeiro -- as formulas das outras apontam pra ela.
        try:
            wb.Worksheets(SYNC).Delete()      # Cells.Clear nao remove QueryTables
        except pywintypes.com_error: pass
        sy = wb.Worksheets.Add(After=wb.Worksheets(wb.Worksheets.Count))
        sy.Name = SYNC
        load(wb, sy, 'Sync_Status', pq_m.m_status(), 1, 1)
        sy.Range('A4').Value = ('This sheet feeds the "Updated ..." stamp on every '
                                'data tab. It refreshes with the rest of the workbook.')
        # Nos arquivos reais a _Sync fica escondida: ela e infraestrutura,
        # e uma aba a mais numa planilha de 27 vira duvida para o time.
        sy.Visible = xlSheetHidden if hide_sync else xlSheetVisible

        # 2) Cada aba de dados.
        for b in bindings:
            t = next(x for x in tabs if x['sheet'] == b['sheet'])
            ws = wb.Worksheets(b['sheet'])
            c0, r0 = split(b['anchor']); n = len(b['cols']); hdr = r0 - 1
            is_sales = b['dataset'] == 'monthly-sales'

            # Duas coisas alargam coluna sem pedir licenca: ListObjects.Add faz
            # autofit da coluna-chave antes do QueryTable existir para receber
            # AdjustColumnWidth=False, e escrever o carimbo (52 caracteres) numa
            # coluna marcada bestFit tambem a estica. Nenhuma das duas da para
            # prevenir, entao a largura e guardada antes de tudo e devolvida no fim.
            keep = [ws.Columns(c).ColumnWidth for c in range(1, 41)]
            for i in range(ws.ListObjects.Count, 0, -1): ws.ListObjects(i).Delete()
            for i in range(ws.QueryTables.Count, 0, -1): ws.QueryTables(i).Delete()
            last = ws.Cells(ws.Rows.Count, c0).End(xlUp).Row
            if last >= hdr:
                ws.Range(ws.Cells(hdr, c0), ws.Cells(last, c0 + n - 1)).ClearContents()

            t0 = time.time()
            lo = load(wb, ws, qname(b['sheet']), pq_m.m_tab(b), c0, hdr)

            # Formato numerico explicito. As abas carregavam formatos herdados
            # do que existia antes: 154 celulas em 0.00% na coluna Total do
            # Coffs (93,65 aparecia como 9365,00%) e celulas em @ no Cairns.
            # A faixa vai bem abaixo da ultima linha porque PreserveFormatting
            # aplica o formato da celula quando a tabela cresce para dentro dela.
            first, band = hdr + 1, 6000
            ws.Range(ws.Cells(first, c0),
                     ws.Cells(first + band, c0)).NumberFormat = '@'
            ws.Range(ws.Cells(first, c0 + 1),
                     ws.Cells(first + band, c0 + n - 1)).NumberFormat = 'General'

            stamp(ws, b, hdr, c0, is_sales)
            for c, w in enumerate(keep, start=1):
                if ws.Columns(c).ColumnWidth != w:
                    ws.Columns(c).ColumnWidth = w
            done.append(dict(sheet=b['sheet'], rows=lo.ListRows.Count,
                             secs=round(time.time() - t0, 1), addr=lo.Range.Address))
            print(f'   {b["sheet"]:<11} {lo.ListRows.Count:>5} linhas  '
                  f'{time.time()-t0:5.1f}s  {lo.Range.Address}')
        wb.Save()
        wb.Close(False)
    finally:
        try: xl.Quit()
        except Exception: pass
    return done


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', help='substring do nome do arquivo')
    ap.add_argument('--real', action='store_true', help='usar a biblioteca do SharePoint')
    ap.add_argument('--hide-sync', action='store_true')
    ap.add_argument('--with-hobart', action='store_true')
    a = ap.parse_args()
    B = json.load(open('/tmp/bindings.json'))
    if not a.with_hobart:
        B = [b for b in B if 'Hobart' not in b['file']]
    folder = REAL if a.real else DIR
    T = json.load(open('/tmp/tabs.json'))
    files = sorted({b['file'] for b in B})
    if a.only: files = [f for f in files if a.only.lower() in f.lower()]
    for fn in files:
        print(f'\n=== {fn} ===')
        migrate(os.path.join(folder, fn),
                [b for b in B if b['file'] == fn],
                [t for t in T if t['file'] == fn], a.hide_sync)
