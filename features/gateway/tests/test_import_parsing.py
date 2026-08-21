"""Tests for the workbook readers in import_gateway_history.

These cover the decisions that decide whether the migrated inventory is right,
and every case here was taken from the real 'Gateway Driver Aug 26.xlsx' rather
than invented: the non-breaking spaces, the transfer reference typed into the
quantity column, '51 CTN P2 TOTAL 102' in First Qty, the #REF! shelves and the
2026-10-27 receipt date.

    python -m unittest discover -s features/gateway/tests -v
"""
import datetime as dt
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "import"))

from import_gateway_history import (          # noqa: E402
    DATE_MIN, _blank, clean, read_5dc, read_date, read_qty, read_tr,
)


class TestBlank(unittest.TestCase):
    def test_none_and_empty(self):
        self.assertTrue(_blank(None))
        self.assertTrue(_blank(""))
        self.assertTrue(_blank("   "))

    def test_non_breaking_space_is_blank(self):
        # The whole 'Date Expected' column is NBSP, and column G carries 56 of
        # them on rows that still hold stock. Treating them as content turned
        # 200-odd empty cells into fake parse failures.
        self.assertTrue(_blank("\xa0"))
        self.assertTrue(_blank("\xa0\xa0 "))

    def test_real_values_are_not_blank(self):
        self.assertFalse(_blank("A1"))
        self.assertFalse(_blank(0))          # zero is a quantity, not a blank
        self.assertFalse(_blank(dt.date(2026, 1, 1)))


class TestReadDate(unittest.TestCase):
    def test_real_datetime(self):
        d, err = read_date(dt.datetime(2026, 4, 22))
        self.assertEqual(d, dt.date(2026, 4, 22))
        self.assertIsNone(err)

    def test_blank(self):
        self.assertEqual(read_date(None), (None, None))
        self.assertEqual(read_date("\xa0"), (None, None))

    def test_text_in_a_date_formatted_cell_is_refused(self):
        for bad in ("17-07", "23-11", "extrusion", "15-ju"):
            d, err = read_date(bad)
            self.assertIsNone(d, f"{bad!r} must not become a date")
            self.assertIn("unparseable", err)

    def test_excel_epoch_junk_is_refused(self):
        # 1900-01-16, 1936-11-28 and 1941-09-21 are all really in the sheet:
        # small numbers typed into a date-formatted cell.
        for bad in (dt.datetime(1900, 1, 16), dt.datetime(1936, 11, 28), dt.datetime(1941, 9, 21)):
            d, err = read_date(bad)
            self.assertIsNone(d)
            self.assertIn("before", err)

    def test_future_date_is_refused(self):
        future = dt.date.today() + dt.timedelta(days=200)
        d, err = read_date(dt.datetime.combine(future, dt.time()))
        self.assertIsNone(d)
        self.assertIn("future", err)

    def test_boundary_is_inclusive(self):
        d, err = read_date(dt.datetime.combine(DATE_MIN, dt.time()))
        self.assertEqual(d, DATE_MIN)
        self.assertIsNone(err)

    def test_near_future_is_allowed(self):
        # A receipt keyed a few days ahead of an expected delivery is normal.
        soon = dt.date.today() + dt.timedelta(days=10)
        d, _ = read_date(dt.datetime.combine(soon, dt.time()))
        self.assertEqual(d, soon)


class TestReadQty(unittest.TestCase):
    def test_numbers(self):
        self.assertEqual(read_qty(299), (299.0, None))
        self.assertEqual(read_qty(0), (0.0, None))
        self.assertEqual(read_qty(12.5), (12.5, None))

    def test_blank(self):
        self.assertEqual(read_qty(None), (None, None))
        self.assertEqual(read_qty("\xa0"), (None, None))

    def test_free_text_is_never_guessed(self):
        # '51 CTN P2 TOTAL 102' holds two plausible quantities. Picking either
        # would be a coin toss recorded as inventory.
        q, err = read_qty("51 CTN P2 TOTAL 102")
        self.assertIsNone(q)
        self.assertIn("non-numeric", err)

    def test_transfer_reference_in_the_quantity_column_is_named(self):
        for ref in ("tr-18646-", "TR-19887", "TR-18313", "tr-17680"):
            q, err = read_qty(ref)
            self.assertIsNone(q)
            self.assertTrue(err.startswith("COLUMN SHIFT"),
                            f"{ref!r} should be reported as a column shift, got {err!r}")

    def test_boolean_is_refused(self):
        q, err = read_qty(True)
        self.assertIsNone(q)
        self.assertIn("boolean", err)


class TestClean(unittest.TestCase):
    def test_excel_errors_never_become_values(self):
        # 36 cells of 'Location Expanded' evaluate to #REF!. A shelf called
        # '#REF!' is worse than no shelf at all.
        for bad in ("#REF!", "#N/A", "#VALUE!", "#DIV/0!", "#NAME?"):
            self.assertIsNone(clean(bad), f"{bad} must not survive")

    def test_trims_and_strips_nbsp(self):
        self.assertEqual(clean("  A12  "), "A12")
        self.assertEqual(clean("FLOOR\xa0"), "FLOOR")

    def test_keeps_real_free_text(self):
        # 'Floor ?' and 'FLOOR ' are real, hand-typed locations.
        self.assertEqual(clean("Floor ?"), "Floor ?")


class TestReadTr(unittest.TestCase):
    def test_normalises_case_and_dash(self):
        self.assertEqual(read_tr("tr-31534"), "TR-31534")
        self.assertEqual(read_tr("TR-30573"), "TR-30573")
        self.assertEqual(read_tr("TR31534"), "TR-31534")

    def test_strips_a_trailing_dash(self):
        self.assertEqual(read_tr("tr-18646-"), "TR-18646")

    def test_leaves_anything_unrecognised_alone(self):
        self.assertEqual(read_tr("GR-309"), "GR-309")
        self.assertEqual(read_tr("8586"), "8586")

    def test_blank(self):
        self.assertIsNone(read_tr(None))
        self.assertIsNone(read_tr("\xa0"))


class TestRead5dc(unittest.TestCase):
    def test_number_and_text_forms_agree(self):
        # SAP stores Item No. as text for pasted rows and as a number for typed
        # ones, so the same code arrives both ways.
        self.assertEqual(read_5dc(30313), "30313")
        self.assertEqual(read_5dc("30313"), "30313")
        self.assertEqual(read_5dc(30313.0), "30313")

    def test_zero_means_the_lookup_found_no_code(self):
        self.assertIsNone(read_5dc(0))
        self.assertIsNone(read_5dc("0"))

    def test_failed_lookup(self):
        self.assertIsNone(read_5dc("#N/A"))
        self.assertIsNone(read_5dc(None))


class TestBalanceRule(unittest.TestCase):
    """The rule that decides every migrated quantity.

    Measured over the 387 SKUs present in both the sheet and Cin7:
        CURRENTY QTY   328 exact (84.8%), 4,010 units apart
        First Qty - withdrawals  186 exact (48.1%), 47,743 units apart
    so the balance is anchored on CURRENTY QTY, and qty_received is derived as
    balance + everything replayed out.
    """

    @staticmethod
    def book(current, first, outs):
        """Mirrors the decision in parse_workbook."""
        out_total = sum(outs)
        if current is not None and current > 0:
            return current + out_total, list(outs), (
                first is not None and abs(first - (current + out_total)) > 1e-9)
        if first is not None and first > 0:
            if out_total > first:
                return first, [], True
            return first, list(outs), False
        return None, [], True

    def test_remaining_lands_on_the_hand_keyed_balance(self):
        received, outs, _ = self.book(199, 299, [50, 100])
        self.assertEqual(received - sum(outs), 199)

    def test_row_4_of_the_real_sheet(self):
        # R6052-WH-TRI: F=199, H=299, out 50 + 100. Cin7 holds 149, so the
        # sheet's own total is 50 too high — but it is still closer than the
        # arithmetic across the whole file, and the disagreement is flagged.
        received, outs, flagged = self.book(199, 299, [50, 100])
        self.assertEqual(received, 349)
        self.assertEqual(received - sum(outs), 199)
        self.assertTrue(flagged, "First Qty disagreeing with the balance must be reported")

    def test_no_first_qty_still_books_the_balance(self):
        # 292 rows that still hold stock have no First Qty at all.
        received, outs, flagged = self.book(96, None, [])
        self.assertEqual(received, 96)
        self.assertEqual(received - sum(outs), 96)
        self.assertFalse(flagged)

    def test_impossible_withdrawals_are_dropped_not_replayed(self):
        # R2582-BK-TRI-60 claims 16,159 withdrawn against a 120 receipt.
        received, outs, flagged = self.book(None, 120, [16159])
        self.assertEqual(received, 120)
        self.assertEqual(outs, [])
        self.assertTrue(flagged)

    def test_unusable_row_is_skipped(self):
        received, _, _ = self.book(None, None, [])
        self.assertIsNone(received)

    def test_agreement_is_not_flagged(self):
        _, _, flagged = self.book(149, 299, [50, 100])
        self.assertFalse(flagged)


if __name__ == "__main__":
    unittest.main(verbosity=2)
