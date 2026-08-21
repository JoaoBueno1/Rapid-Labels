"""M da aba Stock Data: um produto por linha, direto de cin7_mirror.products."""
import re, os

def creds():
    env = {}
    for line in open(os.path.expanduser('~/Rapid-Labels/.env'), encoding='utf8'):
        m = re.match(r'\s*([A-Z0-9_]+)\s*=\s*(.*)', line)
        if m: env[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return env['SUPABASE_URL'], env['SUPABASE_ANON_KEY']

BASE, KEY = creds()

# (campo no banco, cabecalho na aba, tipo). A ordem aqui e a ordem das colunas.
# Fora ficaram, e cada um por um motivo medido:
#   minimum_before_reorder / reorder_quantity / pick_zones  -> 0% preenchidos
#   attribute1  -> ID numerico interno, sem significado de decisao
#   attribute2  -> 71% dos valores sao "0"
#   tags        -> 10% preenchido e cheio de entidades HTML (&amp;)
#   weight      -> 6% preenchido
COLS = [
    # (campo, cabecalho, tratamento). A ordem aqui e a ordem das colunas.
    # 'zeroish' = texto onde o Cin7 guarda o literal "0" no lugar de vazio.
    # 'number'  = vazio quando nulo ou zero, NUNCA 0 -- a diferenca entre
    #             "nao vem em caixa" e "ninguem mediu" tem de continuar visivel.
    ('sku',                    'SKU',                 'key'),
    ('name',                   'Product name',        'text'),
    ('stock_locator',          'Pick bay',            'zeroish'),
    ('category',               'Category',            'text'),
    ('brand',                  'Brand',               'zeroish'),
    ('status',                 'Status',              'text'),
    ('type',                   'Type',                'text'),
    ('uom',                    'UOM',                 'text'),
    ('sellable',               'Sellable',            'text'),
    ('default_location',       'Default location',    'zeroish'),
    ('pick_zones',             'Pick zone',           'zeroish'),
    ('barcode',                'Barcode',             'zeroish'),
    ('carton_quantity',        'Carton OCL',          'number'),
    ('carton_inner_quantity',  'Carton ICL',          'number'),
    ('carton_length',          'Carton L',            'number'),
    ('carton_width',           'Carton W',            'number'),
    ('carton_height',          'Carton H',            'number'),
    ('length',                 'Length',              'number'),
    ('width',                  'Width',               'number'),
    ('height',                 'Height',              'number'),
    ('dimensions_units',       'Dim units',           'text'),
    ('weight',                 'Weight',              'number'),
    ('weight_units',           'Weight units',        'text'),
    ('minimum_before_reorder', 'Min before reorder',  'number'),
    ('reorder_quantity',       'Reorder qty',         'number'),
    ('warranty_name',          'Warranty',            'zeroish'),
    ('tags',                   'Tags',                'tags'),
    ('attribute1',             'Cin7 attr 1',         'zeroish'),
    ('attribute2',             'Model / attr 2',      'zeroish'),
    ('last_modified_on',       'Last modified',       'date'),
]
# Fora ficou so o costing_method: e 'FIFO' nos 11.242, e uma coluna onde toda
# linha e igual nao carrega informacao nenhuma.
# average_cost saiu por decisao do Joao -- o arquivo circula.

def m_stock_data():
    Q = '"'
    sel = ','.join(f for f, _, _ in COLS)
    expand = ', '.join(Q + f + Q for f, _, _ in COLS)
    ren = ', '.join('{%s, %s}' % (Q+f+Q, Q+h+Q) for f, h, _ in COLS)
    # Numero ausente vira vazio, NUNCA zero: so um terco dos produtos tem carton
    # medido, e um zero ali seria lido como "nao vem em caixa" em vez de
    # "ninguem mediu ainda". Texto vazio preserva a diferenca.
    # Numerico ausente vira vazio, NUNCA zero.
    blanks = [ '{%s, each if _ = null or _ = 0 then "" else _}' % (Q+h+Q)
               for _, h, t in COLS if t == 'number' ]
    # E o texto "0" tambem: no Cin7 metade dos stock_locator (5.343 de 11.242)
    # e literalmente a string "0", nao um bin. Contar isso como preenchido
    # dobrava o indice de cobertura do Pick bay -- 46,7% reais viravam 94,2%.
    # Uma coluna Pick bay cheia de "0" pareceria dado e seria ruido.
    blanks += [ '{%s, each if _ = null or Text.Trim(Text.From(_)) = "0" '
                'or Text.Trim(Text.From(_)) = "0.0" or Text.From(_) = "" '
                'then "" else Text.From(_)}' % (Q+h+Q)
                for _, h, t in COLS if t == 'zeroish' ]
    # Os tags vem com entidades HTML cruas do Cin7 ("Flex &amp; Plug").
    blanks += [ '{%s, each if _ = null then "" else '
                'Text.Replace(Text.Replace(Text.From(_), "&amp;", "&"), "&quot;", """""")}'
                % (Q+h+Q) for _, h, t in COLS if t == 'tags' ]
    # Data de verdade, nao o texto ISO cru do Cin7: assim da para ordenar,
    # filtrar e comparar com fórmula. Convertida para Brisbane (UTC+10).
    blanks += [ '{%s, each if _ = null then null else '
                'DateTime.Date(DateTimeZone.RemoveZone(DateTimeZone.ToUtc('
                'DateTimeZone.From(_))) + #duration(0, 10, 0, 0))}' % (Q+h+Q)
                for _, h, t in COLS if t == 'date' ]
    blanks = ', '.join(blanks)
    order = ', '.join(Q + h + Q for _, h, _ in COLS)
    return '''let
    Base = "%s",
    Key  = "%s",
    PAGE = 1000,

    // products vive no schema cin7_mirror; o PostgREST so o enxerga com
    // Accept-Profile. Sem esse cabecalho a resposta e 404 e parece que a
    // tabela nao existe.
    Page = (offset as number) =>
        Json.Document(Web.Contents(Base, [
            RelativePath = "rest/v1/products",
            Query = [ select = "%s",
                      order  = "sku.asc",
                      limit  = Text.From(PAGE),
                      offset = Text.From(offset) ],
            Headers = [ #"apikey" = Key,
                        #"Authorization"  = "Bearer " & Key,
                        #"Accept-Profile" = "cin7_mirror" ]
        ])),
    Pages = List.Generate(
        () => [off = 0, rows = Page(0)],
        each List.Count([rows]) > 0,
        each [off = [off] + PAGE, rows = Page([off] + PAGE)],
        each [rows]),
    All = List.Combine(Pages),

    Raw  = Table.FromList(All, Splitter.SplitByNothing(), {"x"}),
    Wide = Table.ExpandRecordColumn(Raw, "x", {%s}),
    Named = Table.RenameColumns(Wide, {%s}),
    Blank = Table.TransformColumns(Named, {%s}),
    Final = Table.SelectColumns(Blank, {%s}),
    Typed = Table.TransformColumnTypes(Final, {{"SKU", type text}, {"Last modified", type date}})
in
    Typed''' % (BASE, KEY, sel, expand, ren, blanks, order)
