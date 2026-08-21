"""Gera o codigo M. Reproduz engine/flat.py: filtra, SOMA locations, ordena
case-insensitive, arredonda, e pagina -- porque o servidor corta em 1000."""
import re, os, json

def creds():
    env = {}
    for line in open(os.path.expanduser('~/Rapid-Labels/.env'), encoding='utf8'):
        m = re.match(r'\s*([A-Z0-9_]+)\s*=\s*(.*)', line)
        if m: env[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return env['SUPABASE_URL'], env['SUPABASE_ANON_KEY']

BASE, KEY = creds()

# Cabecalho literal da aba -> campo do dataset. A ordem vem do binding.
HEADER = {'sku':'SKU', 'on_hand':'Quantity on hand', 'allocated':'Allocated',
          'on_order':'On order', 'available':'Available',
          'quantity':'Quantity', 'discount':'Discount', 'total':'Total'}

PRETTY = '''    // Brisbane = UTC+10 o ano inteiro (Queensland nao tem horario de verao).
    // Aritmetica EXPLICITA em vez de DateTimeZone.SwitchZone: o motor do
    // Power Query do navegador e o do PC interpretam a conversao de forma
    // diferente, e o carimbo saiu 10h atrasado no navegador (2:26 am em vez
    // de 12:26 pm) enquanto no PC saiu certo. ToUtc normaliza, RemoveZone
    // deixa a leitura de relogio em UTC, e a soma de 10h da Brisbane em
    // qualquer maquina, com qualquer fuso.
    ToBne = (dz as datetimezone) as datetime =>
        DateTimeZone.RemoveZone(DateTimeZone.ToUtc(dz)) + #duration(0, 10, 0, 0),

    // Recebe datetime JA em Brisbane e nao converte nada.
    Pretty = (d as datetime) as text =>
        let
            h24 = Time.Hour(DateTime.Time(d)),
            h12 = if Number.Mod(h24, 12) = 0 then 12 else Number.Mod(h24, 12),
            ap  = if h24 < 12 then "am" else "pm",
            mm  = Text.PadStart(Text.From(Time.Minute(DateTime.Time(d))), 2, "0")
        in
            Date.DayOfWeekName(d, "en-AU") & ", " & Text.From(Date.Day(d)) & " "
            & Date.MonthName(d, "en-AU") & " " & Text.From(Date.Year(d))
            & " at " & Text.From(h12) & ":" & mm & " " & ap & " (Brisbane time)",
'''

def m_status():
    """Uma linha: quando o usuario atualizou e de quando e o dado."""
    return f'''let
    Base = "{BASE}",
    Key  = "{KEY}",

{PRETTY}    Now = ToBne(DateTimeZone.UtcNow()),

    Sets = Json.Document(Web.Contents(Base, [
        RelativePath = "rest/v1/rpc/excel_datasets",
        Headers = [ #"apikey" = Key, #"Authorization" = "Bearer " & Key ] ])),
    Pick = (slug as text) => List.First(List.Select(Sets, each _[slug] = slug), null),
    Stock = Pick("stock-level"),
    Sales = Pick("monthly-sales"),

    Built = (r) => if r = null then "unavailable"
                   else Pretty(ToBne(DateTimeZone.From(r[built_at]))),

    // "2026-08-01..2026-08-31" -> "1 August 2026 to 31 August 2026"
    Span = (r) =>
        if r = null or r[period] = null then "unknown"
        else let
            p  = Text.Split(r[period], ".."),
            f  = (t) => let d = Date.From(t)
                        in Text.From(Date.Day(d)) & " " & Date.MonthName(d, "en-AU")
                           & " " & Text.From(Date.Year(d))
        in f(p{{0}}) & " to " & f(p{{1}}),

    Out = Table.FromRecords({{[
        Refreshed     = Pretty(Now),
        RefreshedDate = Date.From(Now),
        StockBuilt    = Built(Stock),
        SalesBuilt    = Built(Sales),
        SalesPeriod   = Span(Sales),
        StockRows     = if Stock = null then 0 else Stock[row_count],
        SalesRows     = if Sales = null then 0 else Sales[row_count]
    ]}}),
    Typed = Table.TransformColumnTypes(Out, {{
        {{"Refreshed", type text}}, {{"RefreshedDate", type date}},
        {{"StockBuilt", type text}}, {{"SalesBuilt", type text}},
        {{"SalesPeriod", type text}}, {{"StockRows", Int64.Type}},
        {{"SalesRows", Int64.Type}} }})
in
    Typed'''


def m_tab(b):
    """Uma consulta por aba. Passos montados em lista -- f-string aninhada e
    onde os literais do M quebram, e um literal quebrado so aparece no refresh."""
    Q = '"'                                   # aspas literais no M
    QQ = '""'                                 # aspas ESCAPADAS dentro de um texto M
    fields  = [c[0] for c in b['cols']]
    blanks  = [c[0] for c in b['cols'] if c[2]]
    metrics = [f for f in fields if f != 'sku' and f not in blanks]
    rounds  = [(HEADER[c[0]], c[3]) for c in b['cols'] if c[3] is not None]

    loc_lit = ', '.join(Q + l + Q for l in b['locs'])
    # PostgREST: location=in.("Main Warehouse","Gateway") -- nomes tem espaco,
    # entao as aspas sao obrigatorias, e dentro de um texto M viram duplas.
    filt    = 'in.(' + ','.join(QQ + l + QQ for l in b['locs']) + ')'
    expand  = ', '.join(Q + f + Q for f in metrics)
    zeros   = ', '.join('{' + Q + f + Q + ', each _ ?? 0, type number}' for f in metrics)
    aggs    = ', '.join('{' + Q + f + Q + ', each List.Sum([' + f + ']), type number}'
                        for f in metrics)
    ren     = ', '.join('{' + Q + f + Q + ', ' + Q + HEADER[f] + Q + '}'
                        for f in ['sku'] + metrics)
    order   = ', '.join(Q + HEADER[f] + Q for f in fields)

    steps = []
    prev = 'Prev_0'
    for i, f in enumerate(blanks):
        # Coluna escrita em branco so para segurar o layout (Discount).
        steps.append('    Blank_%d = Table.AddColumn(%s, %s, each %s, type text),'
                     % (i, prev, Q + HEADER[f] + Q, Q + Q))
        prev = 'Blank_%d' % i
    steps.append('    Final  = Table.SelectColumns(%s, {%s}),' % (prev, order))
    steps.append('    Typed  = Table.TransformColumnTypes(Final, {{%s, type text}})'
                 % (Q + HEADER['sku'] + Q) + (',' if rounds else ''))
    last = 'Typed'
    if rounds:
        r = ', '.join('{%s, each Number.Round(_, %d), type number}' % (Q + h + Q, n)
                      for h, n in rounds)
        steps.append('    Out    = Table.TransformColumns(Typed, {%s})' % r)
        last = 'Out'

    return """let
    Base = "%s",
    Key  = "%s",
    Dataset   = "%s",
    Locations = {%s},
    PAGE      = 1000,

    // O servidor corta TODA resposta em 1000 linhas (db-max-rows) e ignora em
    // silencio o header Range -- so limit/offset na querystring pagina de
    // verdade. Sem este laco a aba ficaria truncada parecendo certa.
    Page = (offset as number) =>
        Json.Document(Web.Contents(Base, [
            RelativePath = "rest/v1/rpc/excel_dataset_rows",
            Query = [ p_dataset = Dataset,
                      location  = "%s",
                      limit     = Text.From(PAGE),
                      offset    = Text.From(offset) ],
            Headers = [ #"apikey" = Key, #"Authorization" = "Bearer " & Key ]
        ])),
    Pages = List.Generate(
        () => [off = 0, rows = Page(0)],
        each List.Count([rows]) > 0,
        each [off = [off] + PAGE, rows = Page([off] + PAGE)],
        each [rows]),
    All = List.Combine(Pages),

    Raw  = Table.FromList(All, Splitter.SplitByNothing(), {"x"}),
    Cols = Table.ExpandRecordColumn(Raw, "x", {"sku", "metrics"}),
    Wide = Table.ExpandRecordColumn(Cols, "metrics", {%s}),
    // metrica ausente no JSON vira null; flat.py trata como 0
    Zero = Table.TransformColumns(Wide, {%s}),
    // acumula por SKU SEMPRE -- flat.py faz isso mesmo com uma location so
    Sum  = Table.Group(Zero, {"sku"}, {%s}),
    // Cin7 ordena ignorando maiuscula/minuscula; a aba foi colada de la
    Key_ = Table.AddColumn(Sum, "_k", each Text.Lower([sku]), type text),
    Sort = Table.Sort(Key_, {{"_k", Order.Ascending}, {"sku", Order.Ascending}}),
    Bare = Table.RemoveColumns(Sort, {"_k"}),
    Prev_0 = Table.RenameColumns(Bare, {%s}),
%s
in
    %s""" % (BASE, KEY, b['dataset'], loc_lit, filt, expand, zeros, aggs, ren,
             chr(10).join(steps), last)
