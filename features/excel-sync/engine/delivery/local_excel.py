"""Transport: drive the real Excel on this machine, over the OneDrive-synced copy.

Why this exists. The plan was Microsoft Graph, and it is written and works. The
tenant refuses it twice over: app-only consent was never granted, and on
2026-08-11 user consent came back `AADSTS90094` — "an administrator has set a
policy that prevents you from granting this app the permissions it requests".
Both doors need someone we do not have.

This one needs nobody. The SharePoint library is already synced to this machine,
the account already has write access to it, and OneDrive pushes the change back
up. No tenant permission is involved at any point.

**Excel does the saving, not a library.** That is the whole reason this is COM
and not openpyxl. These workbooks carry 2 556 + 2 994 + 1 052 VLOOKUPs across 16
tabs, plus formatting and cached values. openpyxl would rewrite the file from
its own model and quietly drop things it does not model. Excel opening and
saving its own format preserves everything, because nothing is being
reinterpreted.

What it costs, plainly:

  - this machine has to be on, with OneDrive running. A GitHub Actions cron
    cannot reach it; scheduling is Windows Task Scheduler.
  - it runs as Joao. Version history will say so, and it dies with the account.
  - if someone has the workbook open elsewhere, OneDrive resolves it as a
    conflict copy rather than a merge.

It is a bridge, and it should be replaced by `graph.py` the moment an
administrator consents. Both implement the same interface for exactly that
reason — swapping them is one flag, not a rewrite.
"""
import os

from . import graph


def _norm_grid(v):
    """COM hands back a scalar for 1x1 and a tuple of tuples otherwise.

    Graph always returns a rectangle. Normalise to that, so the gates upstream
    never have to know which transport produced the data.
    """
    if v is None:
        return [[None]]
    if not isinstance(v, tuple):
        return [[v]]
    if v and not isinstance(v[0], tuple):
        return [list(v)]
    return [list(r) for r in v]


def _addr(rng):
    """Range.Address is a method under early binding and a property under late.

    Which one you get depends on whether a makepy type library cache exists for
    the installed Excel — i.e. on the machine, not on the code. Handle both, and
    strip the '$' since the callers build relative addresses.
    """
    a = rng.Address
    if callable(a):
        a = a(False, False)
    return str(a).replace('$', '')


def _onedrive_running():
    """Without the sync client the files are cloud-only placeholders and Excel
    opens them as empty or fails outright — a confusing failure worth naming."""
    try:
        import subprocess
        out = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq OneDrive.exe'],
                             capture_output=True, text=True, timeout=30)
        return 'OneDrive.exe' in out.stdout
    except Exception:
        return True          # cannot tell — do not block on a guess


class LocalExcel:
    name = 'local'

    def __init__(self, sb=None, mode=None):
        self.excel = None
        self.wb = None
        self.path = None
        self.calls = 0
        self.read_only = False
        self._prev_calc = None

    # ── the shared transport interface ──────────────────────────────────────
    def open(self, binding, filename, config, read_only=False):
        """`read_only` is how a rehearsal opens a production workbook.

        A dry run only reads, so it should be incapable of writing — not merely
        choosing not to. It also means a rehearsal still works while someone has
        the file open, which is when you most want to be able to check.
        """
        try:
            import win32com.client as win32
        except ImportError:
            raise SystemExit('pywin32 is not installed:  pip install pywin32')

        root = config.get('local_root')
        if not root:
            raise SystemExit(
                'EXCEL_SYNC_LOCAL_ROOT is not set — the synced library root, e.g.\n'
                r'  C:\Users\JoaoMarcos\RapidLED\WorkDocs - Rapid LED - Data')

        # The live library nests the workbooks under
        # `<root>/Inventory Management/Inventory Stock Orders/`; a folder of test
        # copies keeps them side by side. Try the structured path, then flat, so
        # a whole 21-binding run can be aimed at test copies with one --root and
        # no per-binding overrides — which is the difference between rehearsing
        # on copies being easy and being a chore nobody does.
        #
        # An absolute `filename` (from --file) wins outright: os.path.join
        # discards everything before an absolute component.
        folder = (binding['workbook'].get('folder') or '').replace('/', os.sep)
        tried = [os.path.join(root, folder, filename), os.path.join(root, filename)]
        self.path = next((p for p in tried if os.path.exists(p)), None)
        if not self.path:
            raise SystemExit('workbook not found on disk. Tried:\n  ' + '\n  '.join(tried))

        if not _onedrive_running():
            raise SystemExit(
                'OneDrive.exe is not running. The files are cloud-only placeholders\n'
                '  without it, and nothing written here would reach SharePoint.\n'
                '  Start OneDrive, wait for it to finish syncing, then re-run.')

        size = os.path.getsize(self.path)

        # DispatchEx, not Dispatch: a private Excel instance. Attaching to the
        # one the user has open would inherit its state and, worse, our
        # DisplayAlerts=False would apply to their session too.
        self.excel = win32.DispatchEx('Excel.Application')
        self.excel.Visible = False
        self.excel.DisplayAlerts = False
        self.excel.AskToUpdateLinks = False
        self.excel.EnableEvents = False           # no workbook macros on open

        try:
            self.wb = self.excel.Workbooks.Open(
                self.path, UpdateLinks=0, ReadOnly=read_only,
                IgnoreReadOnlyRecommended=True)
        except Exception as e:
            self.close()
            raise SystemExit(f'Excel could not open the workbook:\n  {self.path}\n  {e}')

        if self.wb.ReadOnly and not read_only:
            self.close()
            raise SystemExit(
                'Excel opened the workbook READ-ONLY — someone else has it open,\n'
                '  or the sync is mid-flight. Nothing was changed. Try again later.')
        self.read_only = read_only

        # 2 556 VLOOKUPs recalculating after every batch would dominate the run.
        # Held off until save(), which recalculates once.
        self._prev_calc = self.excel.Calculation
        self.excel.Calculation = -4135            # xlCalculationManual

        return {'id': self.path, 'location': root,
                'describe': f'{filename} · {size} bytes · local synced copy'
                            + (' · opened READ-ONLY' if read_only else '')}

    def _ws(self, sheet):
        try:
            return self.wb.Worksheets(sheet)
        except Exception:
            names = [self.wb.Worksheets(i + 1).Name for i in range(self.wb.Worksheets.Count)]
            raise SystemExit(f'workbook has no sheet {sheet!r}. Sheets: {", ".join(names)}')

    def used_range(self, sheet):
        ws = self._ws(sheet)
        ur = ws.UsedRange
        self.calls += 1
        return {'address': _addr(ur),
                'values': _norm_grid(ur.Value2),
                'formulas': _norm_grid(ur.Formula)}

    def read_range(self, sheet, address):
        rng = self._ws(sheet).Range(address)
        self.calls += 1
        return {'address': address,
                'values': _norm_grid(rng.Value2),
                'formulas': _norm_grid(rng.Formula)}

    def write_range(self, sheet, address, values):
        if self.read_only:
            raise SystemExit('BUG: write attempted on a read-only handle. Refused.')
        # Value2 interprets a leading '=' as a formula. Our data is SKUs and
        # numbers, but "should never happen" is not a guarantee, and one such
        # cell would write a formula into a data tab and spread from there.
        for r, row in enumerate(values):
            for c, v in enumerate(row):
                if isinstance(v, str) and v[:1] in ('=', '@'):
                    raise SystemExit(
                        f'refusing to write {v[:40]!r} at row {r + 1} col {c + 1} of '
                        f'{address}: Excel would take it as a formula.')

        rng = self._ws(sheet).Range(address)
        payload = tuple(tuple(row) for row in values)
        if rng.Rows.Count != len(payload) or rng.Columns.Count != len(payload[0]):
            raise SystemExit(
                f'range {address} is {rng.Rows.Count}x{rng.Columns.Count} but the '
                f'block is {len(payload)}x{len(payload[0])}')
        rng.Value2 = payload          # one COM call for the whole rectangle
        self.calls += 1

    def clear_range(self, sheet, address):
        self._ws(sheet).Range(address).ClearContents()
        self.calls += 1

    def save(self):
        """Recalculate, then let Excel write its own format. OneDrive does the rest."""
        if self.read_only:
            raise SystemExit('BUG: save attempted on a read-only handle. Refused.')
        self.excel.Calculation = -4105            # xlCalculationAutomatic
        self.excel.CalculateFullRebuild()
        self._prev_calc = None
        self.wb.Save()
        self.calls += 1

    def close(self, saved=False):
        # Always tear down: an orphaned EXCEL.EXE holds a lock on the file, and
        # the next run would find it read-only for no visible reason.
        try:
            if self.wb is not None:
                if self._prev_calc is not None:
                    try:
                        self.excel.Calculation = self._prev_calc
                    except Exception:
                        pass
                self.wb.Close(SaveChanges=False)
        except Exception as e:
            print(f'  ! closing workbook: {e}')
        finally:
            self.wb = None
            try:
                if self.excel is not None:
                    self.excel.Quit()
            except Exception:
                pass
            self.excel = None


# The two transports are interchangeable by design; the gates in __init__.py
# call nothing that is specific to either.
TRANSPORTS = {'graph': graph.Graph, 'local': LocalExcel}
