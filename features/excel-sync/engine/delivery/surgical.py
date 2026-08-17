"""Write cells into an .xlsx by replacing only the sheet XML that changes.

Why not openpyxl: it parses the whole workbook into Python objects and writes a
brand-new zip from them. Anything it cannot model has no object to write back,
so it vanishes — measured on the real Coffs Harbour workbook, a no-op round-trip
dropped 20 parts including the TR-48681 barcode on 'Print Layout', the print
setup of three sheets, and all customXml. That is damage to sheets we never even
touch, purely a side effect of how the library saves.

Why not xlwings/COM: it is faithful, but needs Excel installed and a logged-in
desktop session, and cannot be tested from here.

So: treat the file as what it is, a zip of XML. Copy every part across
byte-for-byte, and rewrite only `xl/worksheets/sheetN.xml` for the sheets we
write. Nothing else can be lost, because nothing else is touched.

Two rules that keep the rewrite safe:
  - values are written as INLINE strings/numbers, never through sharedStrings,
    so that shared table (used by every other sheet) is never disturbed;
  - each cell keeps the `s=` style index it already had, so formatting, number
    formats and column widths survive.
"""
import re
import shutil
import zipfile
from xml.sax.saxutils import escape

# openpyxl is used ONLY to resolve sheet name -> sheetN.xml. It never saves.
_SHEET_RE = re.compile(rb'<sheet[^>]*?name="([^"]*)"[^>]*?r:id="([^"]*)"[^>]*?/>')
_REL_RE = re.compile(rb'<Relationship[^>]*?Id="([^"]*)"[^>]*?Target="([^"]*)"[^>]*?/>')


def _col_to_num(col):
    n = 0
    for ch in col:
        n = n * 26 + (ord(ch.upper()) - 64)
    return n


def _num_to_col(n):
    s = ''
    while n:
        n, rem = divmod(n - 1, 26)
        s = chr(65 + rem) + s
    return s


def sheet_paths(xlsx):
    """{sheet name: 'xl/worksheets/sheetN.xml'} straight from the package."""
    with zipfile.ZipFile(xlsx) as z:
        wb = z.read('xl/workbook.xml')
        rels = z.read('xl/_rels/workbook.xml.rels')
    rid = {m.group(1).decode(): m.group(2).decode() for m in _REL_RE.finditer(rels)}
    out = {}
    for m in _SHEET_RE.finditer(wb):
        name = m.group(1).decode()
        target = rid.get(m.group(2).decode(), '')
        if not target:
            continue
        target = target.lstrip('/')
        out[name] = target if target.startswith('xl/') else 'xl/' + target
    return out


def _cell_xml(ref, value, style_attr):
    """One <c>. Inline strings keep sharedStrings.xml untouched."""
    s = f' s="{style_attr}"' if style_attr else ''
    if value is None or value == '':
        return f'<c r="{ref}"{s}/>'
    if isinstance(value, bool):
        return f'<c r="{ref}"{s} t="b"><v>{int(value)}</v></c>'
    if isinstance(value, (int, float)):
        v = int(value) if isinstance(value, float) and value.is_integer() else value
        return f'<c r="{ref}"{s}><v>{v}</v></c>'
    return f'<c r="{ref}"{s} t="inlineStr"><is><t xml:space="preserve">{escape(str(value))}</t></is></c>'


def _parse_row_cells(row_xml):
    """{'B': (full <c> xml, style index)} for one <row>."""
    out = {}
    for m in re.finditer(r'<c\b[^>]*?r="([A-Z]+)(\d+)"([^>]*?)(?:/>|>(.*?)</c>)', row_xml, re.S):
        col, _, attrs, _body = m.group(1), m.group(2), m.group(3), m.group(4)
        sm = re.search(r'\bs="(\d+)"', attrs)
        out[col] = (m.group(0), sm.group(1) if sm else None)
    return out


def write_sheet_block(sheet_xml, anchor_col, anchor_row, grid, clear_to_row=None):
    """Replace a rectangular block inside one sheet's XML.

    `clear_to_row` blanks our columns from the end of the block down to that row —
    the case where this month has fewer SKUs than last, which would otherwise
    leave yesterday's rows alive underneath and silently mix two days of data.
    """
    xml = sheet_xml.decode('utf-8')
    c0 = _col_to_num(anchor_col)
    width = max((len(r) for r in grid), default=0)
    last_row = anchor_row + len(grid) - 1
    touched = {anchor_row + i: row for i, row in enumerate(grid)}
    blank_rows = set()
    if clear_to_row and clear_to_row > last_row:
        blank_rows = set(range(last_row + 1, clear_to_row + 1))

    def rebuild(m):
        whole, attrs, body = m.group(0), m.group(1), m.group(2) or ''
        rm = re.search(r'\br="(\d+)"', attrs)
        if not rm:
            return whole
        rnum = int(rm.group(1))
        if rnum not in touched and rnum not in blank_rows:
            return whole
        existing = _parse_row_cells(body)
        values = touched.get(rnum)
        pieces = []
        for col_letter, (cell_xml, style) in sorted(existing.items(), key=lambda kv: _col_to_num(kv[0])):
            idx = _col_to_num(col_letter) - c0
            if 0 <= idx < width:
                continue                       # ours: re-emitted below in order
            pieces.append((_col_to_num(col_letter), cell_xml))
        for idx in range(width):
            col_letter = _num_to_col(c0 + idx)
            ref = f'{col_letter}{rnum}'
            style = existing.get(col_letter, (None, None))[1]
            v = values[idx] if values is not None and idx < len(values) else None
            pieces.append((c0 + idx, _cell_xml(ref, v, style)))
        pieces.sort(key=lambda p: p[0])
        inner = ''.join(p[1] for p in pieces)
        new_attrs = re.sub(r'\s+spans="[^"]*"', '', attrs)   # let Excel recompute
        return f'<row{new_attrs}>{inner}</row>'

    xml, _n = re.subn(r'<row\b(.*?)(?:/>|>(.*?)</row>)', rebuild, xml, flags=re.S)

    # rows the sheet never had (the block grew past the old extent)
    have = {int(m.group(1)) for m in re.finditer(r'<row\b[^>]*?\br="(\d+)"', xml)}
    missing = sorted(r for r in touched if r not in have)
    if missing:
        additions = []
        for rnum in missing:
            values = touched[rnum]
            cells = ''.join(
                _cell_xml(f'{_num_to_col(c0 + i)}{rnum}', values[i] if i < len(values) else None, None)
                for i in range(width))
            additions.append(f'<row r="{rnum}">{cells}</row>')
        xml = xml.replace('</sheetData>', ''.join(additions) + '</sheetData>')

    # <dimension> must cover what we wrote or Excel may clip the used range
    dm = re.search(r'<dimension ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/>', xml)
    if dm:
        end_col = max(_col_to_num(dm.group(3)), c0 + width - 1)
        end_row = max(int(dm.group(4)), last_row)
        xml = xml.replace(dm.group(0),
                          f'<dimension ref="{dm.group(1)}{dm.group(2)}:{_num_to_col(end_col)}{end_row}"/>')
    return xml.encode('utf-8')


def last_data_row(xlsx, sheet_path, col_letter, start_row):
    """How far the previous block reached, by its key column."""
    with zipfile.ZipFile(xlsx) as z:
        xml = z.read(sheet_path).decode('utf-8')
    last = start_row - 1
    for m in re.finditer(r'<row\b[^>]*?\br="(\d+)"[^>]*?(?:/>|>(.*?)</row>)', xml, re.S):
        rnum = int(m.group(1))
        if rnum < start_row:
            continue
        body = m.group(2) or ''
        cm = re.search(rf'<c\b[^>]*?r="{col_letter}{rnum}"[^>]*?(?:/>|>(.*?)</c>)', body, re.S)
        if cm and cm.group(1) and '<v>' in cm.group(1) or (cm and '<is>' in (cm.group(1) or '')):
            last = max(last, rnum)
    return last


def apply(xlsx_path, edits, backup_path=None):
    """edits: [{sheet, anchor_col, anchor_row, grid, clear_to_row?}]

    Rewrites the package with every part copied verbatim except the sheets we
    touch, so drawings, printer settings, customXml and sharedStrings survive
    unchanged — that is the whole point of doing it this way.
    """
    if backup_path:
        shutil.copy2(xlsx_path, backup_path)

    paths = sheet_paths(xlsx_path)
    by_path = {}
    for e in edits:
        if e['sheet'] not in paths:
            raise SystemExit(f"no sheet named {e['sheet']!r} in {xlsx_path}")
        by_path[paths[e['sheet']]] = e

    tmp = xlsx_path + '.tmp'
    with zipfile.ZipFile(xlsx_path) as zin, \
            zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            e = by_path.get(item.filename)
            if e is not None:
                data = write_sheet_block(data, e['anchor_col'], e['anchor_row'],
                                         e['grid'], e.get('clear_to_row'))
            # calcChain indexes formula cells by position; stale entries make
            # Excel complain on open. Dropping it is safe — Excel rebuilds it.
            if item.filename == 'xl/calcChain.xml':
                continue
            zout.writestr(item, data)
    shutil.move(tmp, xlsx_path)
    return {'sheets': [e['sheet'] for e in edits], 'parts_rewritten': len(by_path)}
