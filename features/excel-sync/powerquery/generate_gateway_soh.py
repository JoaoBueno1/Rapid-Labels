"""SOH Dear do Gateway: todo produto Active, com a quantidade do Gateway ao lado.

Mantem as 9 colunas exatas do export do Cin7 porque 998 formulas do arquivo
leem esta aba -- e as fórmulas usam so A (SKU) e C (Quantity on hand), entao a
posicao dessas duas e intocavel.

Lista TODOS os ativos, nao so quem tem saldo: o stock_snapshot so guarda linha
onde ha movimento, e trocar a aba pelos 564 do Gateway faria 2.359 SKUs virarem
#N/A. Com todos os ativos, nenhuma busca falha e quem nao tem estoque mostra 0,
que e exatamente o que o relatorio do Cin7 ja faz hoje.
"""
import os, re
def _c():
    env = {}
    for l in open(os.path.expanduser('~/Rapid-Labels/.env'), encoding='utf8'):
        m = re.match(r'\s*([A-Z0-9_]+)\s*=\s*(.*)', l)
        if m: env[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return env['SUPABASE_URL'], env['SUPABASE_ANON_KEY']
BASE, KEY = _c()

def m_gateway_soh():
    return '''let
    Base = "%s",
    Key  = "%s",
    PAGE = 1000,
    H    = [ #"apikey" = Key, #"Authorization" = "Bearer " & Key,
             #"Accept-Profile" = "cin7_mirror" ],

    ProdPage = (off as number) =>
        Json.Document(Web.Contents(Base, [
            RelativePath = "rest/v1/products",
            Query = [ select = "sku,uom,average_cost", status = "eq.Active",
                      order = "sku.asc",
                      limit = Text.From(PAGE), offset = Text.From(off) ],
            Headers = H ])),
    Prod = Table.FromRecords(List.Combine(List.Generate(
        () => [o = 0, r = ProdPage(0)], each List.Count([r]) > 0,
        each [o = [o] + PAGE, r = ProdPage([o] + PAGE)], each [r]))),

    StockPage = (off as number) =>
        Json.Document(Web.Contents(Base, [
            RelativePath = "rest/v1/stock_snapshot",
            Query = [ select = "sku,on_hand,allocated,on_order,in_transit,stock_on_hand,available",
                      location_name = "eq.Gateway",
                      limit = Text.From(PAGE), offset = Text.From(off) ],
            Headers = H ])),
    Stock = Table.FromRecords(List.Combine(List.Generate(
        () => [o = 0, r = StockPage(0)], each List.Count([r]) > 0,
        each [o = [o] + PAGE, r = StockPage([o] + PAGE)], each [r]))),

    // stock_snapshot e por BIN: soma por SKU antes de juntar
    G = Table.Group(Stock, {"sku"}, {
        {"on_hand",       each List.Sum(List.Transform([on_hand],       each _ ?? 0)), type number},
        {"allocated",     each List.Sum(List.Transform([allocated],     each _ ?? 0)), type number},
        {"on_order",      each List.Sum(List.Transform([on_order],      each _ ?? 0)), type number},
        {"in_transit",    each List.Sum(List.Transform([in_transit],    each _ ?? 0)), type number},
        {"stock_on_hand", each List.Sum(List.Transform([stock_on_hand], each _ ?? 0)), type number},
        {"available",     each List.Sum(List.Transform([available],     each _ ?? 0)), type number} }),

    J = Table.NestedJoin(Prod, {"sku"}, G, {"sku"}, "s", JoinKind.LeftOuter),
    E = Table.ExpandTableColumn(J, "s",
          {"on_hand","allocated","on_order","in_transit","stock_on_hand","available"}),
    // sem saldo no Gateway = 0, como o relatorio do Cin7 mostra
    Z = Table.TransformColumns(E, {
          {"on_hand", each _ ?? 0, type number}, {"allocated", each _ ?? 0, type number},
          {"on_order", each _ ?? 0, type number}, {"in_transit", each _ ?? 0, type number},
          {"stock_on_hand", each _ ?? 0, type number}, {"available", each _ ?? 0, type number},
          {"average_cost", each _ ?? 0, type number}}),
    R = Table.RenameColumns(Z, {
          {"sku","SKU"}, {"uom","Unit"}, {"on_hand","Quantity on hand"},
          {"allocated","Allocated"}, {"on_order","On order"},
          {"in_transit","In transit"}, {"average_cost","Unit cost"},
          {"stock_on_hand","Stock on hand"}, {"available","Available"}}),
    Out = Table.SelectColumns(R, {"SKU","Unit","Quantity on hand","Allocated",
            "On order","In transit","Unit cost","Stock on hand","Available"}),
    Typed = Table.TransformColumnTypes(Out, {{"SKU", type text}, {"Unit", type text}})
in
    Typed''' % (BASE, KEY)
