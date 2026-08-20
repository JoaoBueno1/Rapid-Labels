"""M da aba Restock Suggestion.

Agora e uma consulta trivial: UMA fonte, RelativePath literal, uma chamada.
Todo o calculo vive em db/006_restock_suggestion.sql.

A versao anterior tentava fazer a conta aqui, juntando tres fontes (medias do
schema public, estoque da filial e estoque do Main, os dois em cin7_mirror). O
Power Query recusa: "references other queries or steps, so it may not directly
access a data source" -- e FastCombine=True nao resolve. As consultas que ja
rodam em producao passam porque cada uma e fonte unica com caminho literal, e
esta agora tem a mesma forma. De quebra a regra vive num lugar so, em vez de
copiada dentro de 7 planilhas.
"""
import os, re

def _creds():
    env = {}
    for line in open(os.path.expanduser('~/Rapid-Labels/.env'), encoding='utf8'):
        m = re.match(r'\s*([A-Z0-9_]+)\s*=\s*(.*)', line)
        if m: env[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return env['SUPABASE_URL'], env['SUPABASE_ANON_KEY']

BASE, KEY = _creds()

SUFFIX = {'Sydney':'sydney', 'Melbourne':'melbourne', 'Brisbane':'brisbane',
          'Cairns':'cairns', 'Coffs Harbour':'coffs_harbour', 'Hobart':'hobart',
          'Sunshine Coast Warehouse':'sunshine_coast'}

COLS = [('sku',           'SKU'),
        ('suggested_qty', 'Suggested qty'),
        ('available_now', 'Available now'),
        ('avg_month',     'Avg / month'),
        ('main_gateway',  'Main + Gateway')]

TEMPLATE = '''let
    Base   = "@BASE@",
    Key    = "@KEY@",
    Branch = "@BRANCH@",
    PAGE   = 1000,

    // A RPC ja devolve filtrado e ordenado: media > 0, Main+Gateway > 0, nada
    // em transito, cobertura abaixo de 25 dias. A regra esta no SQL, nao aqui.
    Page = (offset as number) =>
        Json.Document(Web.Contents(Base, [
            RelativePath = "rest/v1/rpc/excel_restock_suggestion",
            Query = [ p_branch = Branch,
                      limit    = Text.From(PAGE),
                      offset   = Text.From(offset) ],
            Headers = [ #"apikey" = Key, #"Authorization" = "Bearer " & Key ]
        ])),
    Pages = List.Generate(
        () => [off = 0, rows = Page(0)],
        each List.Count([rows]) > 0,
        each [off = [off] + PAGE, rows = Page([off] + PAGE)],
        each [rows]),
    All = List.Combine(Pages),

    Raw   = Table.FromList(All, Splitter.SplitByNothing(), {"x"}),
    Wide  = Table.ExpandRecordColumn(Raw, "x", {@FIELDS@}),
    Named = Table.RenameColumns(Wide, {@RENAME@}),
    Typed = Table.TransformColumnTypes(Named, {{"SKU", type text}})
in
    Typed'''


def m_restock(location):
    esc = lambda s: s.replace('"', '""')
    fields = ', '.join('"%s"' % f for f, _ in COLS)
    rename = ', '.join('{"%s", "%s"}' % (f, h) for f, h in COLS)
    return (TEMPLATE.replace('@BASE@', BASE).replace('@KEY@', KEY)
            .replace('@BRANCH@', esc(location))
            .replace('@FIELDS@', fields).replace('@RENAME@', rename))
