"""Referencia em Python do mesmo algoritmo, para conferir o M."""
import re, os, json, math, urllib.request, urllib.parse, collections
env = {}
for line in open(os.path.expanduser('~/Rapid-Labels/.env'), encoding='utf8'):
    m = re.match(r'\s*([A-Z0-9_]+)\s*=\s*(.*)', line)
    if m: env[m.group(1)] = m.group(2).strip().strip('"').strip("'")
URL, AK = env['SUPABASE_URL'], env['SUPABASE_ANON_KEY']
SUF = {'Sydney':'sydney','Melbourne':'melbourne','Brisbane':'brisbane','Cairns':'cairns',
       'Coffs Harbour':'coffs_harbour','Hobart':'hobart','Sunshine Coast Warehouse':'sunshine_coast'}
ALL = list(SUF.values())
EXCL = {s.upper() for s in json.load(open('/tmp/excluded_skus.json'))}
W = 4.345

def get(path, params, schema=None, page=True):
    out, off = [], 0
    while True:
        p = dict(params); p['limit'] = '1000'; p['offset'] = str(off)
        r = urllib.request.Request(f'{URL}/rest/v1/{path}?' + urllib.parse.urlencode(p))
        r.add_header('apikey', AK); r.add_header('Authorization','Bearer '+AK)
        if schema: r.add_header('Accept-Profile', schema)
        d = json.load(urllib.request.urlopen(r, timeout=180))
        out += d
        if not page or len(d) < 1000: return out
        off += 1000

def excluded(sku, name):
    s = (sku or '').upper(); n = (name or '').lower()
    if s in EXCL: return True
    if 'carton' in s.lower(): return True
    if s.lower().endswith(('-v1','_v1')): return True
    if ' per metre' in n or ' per meter' in n or '/m' in n: return True
    return False

def run(branch):
    suf = SUF[branch]
    avg = get('branch_avg_monthly_sales',
              {'select': 'product,' + ','.join(f'avg_mth_{b},avg_rep_{b}' for b in ALL)})
    net = []
    for r in avg:
        t = 0.0
        for b in ALL:
            rep, mth = r.get(f'avg_rep_{b}'), r.get(f'avg_mth_{b}')
            t += float(rep) if (rep and float(rep) > 0) else float(mth or 0)
        if t > 0: net.append((r, t))
    net.sort(key=lambda x: -x[1])
    n = len(net); cutA, cutB = math.ceil(n*0.20), math.ceil(n*0.50)
    info = {}
    for i, (r, _) in enumerate(net):
        weeks = 10 if i < cutA else (8 if i < cutB else 6)
        rep, mth = r.get(f'avg_rep_{suf}'), r.get(f'avg_mth_{suf}')
        a = float(rep) if (rep and float(rep) > 0) else float(mth or 0)
        info[r['product']] = (weeks, a)

    st = get('stock_snapshot', {'select':'sku,product_name,available,in_transit',
                                'location_name': f'eq.{branch}'}, schema='cin7_mirror')
    mr = get('stock_snapshot', {'select':'sku,available',
             'location_name':'in.("Main Warehouse","Gateway")'}, schema='cin7_mirror')
    main = collections.defaultdict(float)
    for x in mr: main[x['sku']] += float(x.get('available') or 0)
    agg = {}
    for x in st:
        a = agg.setdefault(x['sku'], {'name': x.get('product_name'), 'av':0.0, 'it':0.0})
        a['av'] += float(x.get('available') or 0); a['it'] += float(x.get('in_transit') or 0)

    rows = []
    # Parte da lista COM MEDIA, nao do estoque: um SKU zerado na filial nao
    # tem linha no snapshot e sumiria (31 dos 46 da lista real do Joao).
    for sku, (weeks, avgM) in info.items():
        a = agg.get(sku, {'name': None, 'av': 0.0, 'it': 0.0})
        avgW = avgM / W
        target = math.ceil(avgW * weeks) if avgM > 0 else 0
        need = math.ceil(max(0, target - a['av']) if avgM > 0 else (abs(a['av']) if a['av'] < 0 else 0))
        cover = max(0, round(a['av']/avgW*7)) if avgM > 0 and avgW > 0 else 0
        if excluded(sku, a['name']): continue
        if (avgM > 0 and main.get(sku, 0) > 0 and need > 0
                and cover < 25 and a['it'] == 0):
            rows.append((sku, need, cover, a['av'], avgM, target, main.get(sku,0)))
    rows.sort(key=lambda r: (r[2], -r[1]))
    return rows, n, cutA, cutB

if __name__ == '__main__':
    import sys
    for b in (sys.argv[1:] or ['Sydney']):
        rows, n, ca, cb = run(b)
        print(f'\n{b}: {len(rows)} sugestoes   (ABC sobre {n} SKUs: A<{ca} B<{cb})')
        print(f'   {"SKU":<26}{"sugerido":>9}{"cover":>7}{"disp":>8}{"avg/mes":>9}{"alvo":>7}')
        for r in rows[:10]:
            print(f'   {r[0]:<26}{r[1]:>9g}{r[2]:>7g}{r[3]:>8g}{r[4]:>9.1f}{r[5]:>7g}')
        print(f'   total sugerido: {sum(r[1] for r in rows):g} unidades')
