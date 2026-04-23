/**
 * Replenishment Config — single source of truth for business rules.
 *
 * Every threshold, safety window, and carton rule lives here.
 * Changing a rule in one place updates overview, branch detail, and all-branches views.
 *
 * Exposed on window as window.ReplenishmentConfig.
 */
(function () {
  'use strict';

  // ──────────────────────────────────────────────────────────────────
  // TIME CONVERSION
  // ──────────────────────────────────────────────────────────────────
  // 365.25 days / 7 days per week / 12 months = 4.348 weeks/month.
  // We use 4.345 (business rounding, matches the original planner).
  const WEEKS_IN_MONTH = 4.345;

  // ──────────────────────────────────────────────────────────────────
  // COVERAGE WINDOWS
  // ──────────────────────────────────────────────────────────────────
  // BRANCH_TARGET_WEEKS: how many weeks of stock each branch should hold.
  //   6 weeks covers monthly sales + a half-month buffer for the next
  //   replenishment cycle (typical Main → Branch cadence is 2-3 weeks
  //   in this network). Lower = more frequent transfers, higher = tied-up capital.
  const BRANCH_TARGET_WEEKS = 6;

  // MAIN_MIN_WEEKS: safety stock Main/Gateway must keep before shipping.
  //   8 weeks ≈ supplier lead time (4-6 wks) + processing buffer (2 wks).
  //   Below this, Main itself becomes the bottleneck.
  const MAIN_MIN_WEEKS = 8;

  // LEAD_TIME_DAYS: assumed in-transit time for a Main → Branch transfer.
  //   Added to the branch target so stock arrives *before* runout.
  //   Default covers interstate freight; override per-branch via restock_setup
  //   later (future work).
  const LEAD_TIME_DAYS = 5;

  // ──────────────────────────────────────────────────────────────────
  // CARTON ROUNDING
  // ──────────────────────────────────────────────────────────────────
  // Round-up is accepted only if it stays under this multiple of target.
  //   3× = up to 18 weeks cover when target is 6 weeks.
  //   Prevents slow movers from getting flooded when a carton is big
  //   relative to demand (e.g. CTN=12 but branch needs 4).
  const CARTON_ROUND_UP_MAX_RATIO = 3;

  // Max months of stock a branch can hold when Cartons Only mode is on.
  //   Hard ceiling independent of target weeks.
  const CARTON_MODE_MAX_MONTHS = 6;

  // ──────────────────────────────────────────────────────────────────
  // MIN SEND THRESHOLD
  // ──────────────────────────────────────────────────────────────────
  // Don't bother shipping below this qty when the branch already has stock.
  //   If CTN is known → half a carton.
  //   If CTN is unknown → floor of 3 units.
  //   Oversold branches (soldDeficit > 0) bypass this.
  const MIN_SEND_FALLBACK_UNITS = 3;

  // ──────────────────────────────────────────────────────────────────
  // DATA FRESHNESS
  // ──────────────────────────────────────────────────────────────────
  // Sync age buckets (minutes).
  //   ≤ WARN: neutral
  //   WARN-BLOCK: amber warning, still usable
  //   > BLOCK: red, recommendations hidden / user prompted
  const SYNC_WARN_MINUTES = 75;   // ~15 min past the hourly sync window
  const SYNC_BLOCK_MINUTES = 120; // 2h — hard block, data likely wrong

  // Expected rows per successful sync — flags partial failures.
  // Tune as the catalogue grows. Null disables the check.
  const SYNC_MIN_STOCK_ROWS = 500;
  const SYNC_MIN_PRODUCTS = 100;

  // ──────────────────────────────────────────────────────────────────
  // COVER DAY BANDS (UI categorisation)
  // ──────────────────────────────────────────────────────────────────
  const COVER_CRITICAL_DAYS = 7;
  const COVER_WARNING_DAYS = 21;
  const COVER_OK_DAYS = 35;

  // ──────────────────────────────────────────────────────────────────
  // PRODUCT FILTERS
  // ──────────────────────────────────────────────────────────────────
  // SKUs whose name matches any of these regexes are excluded.
  //   Original rule was substring 'carton' — kept but made explicit.
  //   Add more here if new non-stocked SKU patterns appear.
  const EXCLUDED_NAME_PATTERNS = [
    /\bcarton\b/i
  ];

  // Whether zero-AVG branches are surfaced as 'no data' rows (branch detail
  // page only) or hidden entirely (overview + all-branches page).
  //   Historical mismatch: overview hid them, branch detail showed them.
  //   Consolidated here — both modes available, UI chooses.
  function isExcludedProduct(productCode) {
    if (!productCode) return true;
    const s = String(productCode);
    return EXCLUDED_NAME_PATTERNS.some(rx => rx.test(s));
  }

  // ──────────────────────────────────────────────────────────────────
  // WAREHOUSE MAPPING
  // ──────────────────────────────────────────────────────────────────
  const CIN7_LOCATION_MAP = {
    'main warehouse': 'MAIN',
    'main': 'MAIN',
    'gateway': 'MAIN',
    'gateway warehouse': 'MAIN',
    'sydney': 'SYD',
    'sydney warehouse': 'SYD',
    'melbourne': 'MEL',
    'melbourne warehouse': 'MEL',
    'brisbane': 'BNE',
    'brisbane warehouse': 'BNE',
    'cairns': 'CNS',
    'cairns warehouse': 'CNS',
    'coffs harbour': 'CFS',
    'coffs harbour warehouse': 'CFS',
    'hobart': 'HBA',
    'hobart warehouse': 'HBA',
    'sunshine coast warehouse': 'SCS',
    'sunshine coast': 'SCS'
  };

  const BRANCHES = [
    { code: 'SYD', name: 'Sydney', avgField: 'avg_mth_sydney' },
    { code: 'MEL', name: 'Melbourne', avgField: 'avg_mth_melbourne' },
    { code: 'BNE', name: 'Brisbane', avgField: 'avg_mth_brisbane' },
    { code: 'CNS', name: 'Cairns', avgField: 'avg_mth_cairns' },
    { code: 'CFS', name: 'Coffs Harbour', avgField: 'avg_mth_coffs_harbour' },
    { code: 'HBA', name: 'Hobart', avgField: 'avg_mth_hobart' },
    { code: 'SCS', name: 'Sunshine Coast', avgField: 'avg_mth_sunshine_coast' }
  ];

  // ──────────────────────────────────────────────────────────────────
  // HELPERS
  // ──────────────────────────────────────────────────────────────────

  // Effective target: branch cover + lead-time days.
  // Returns integer units.
  function computeBranchTarget(avgMonth) {
    if (!avgMonth || avgMonth <= 0) return 0;
    const avgWeek = avgMonth / WEEKS_IN_MONTH;
    const avgDay = avgMonth / (WEEKS_IN_MONTH * 7);
    return Math.ceil(avgWeek * BRANCH_TARGET_WEEKS + avgDay * LEAD_TIME_DAYS);
  }

  // Main safety stock: minimum Main must keep.
  function computeMainSafety(avgMonthMain) {
    if (!avgMonthMain || avgMonthMain <= 0) return 0;
    const avgWeek = avgMonthMain / WEEKS_IN_MONTH;
    return Math.ceil(avgWeek * MAIN_MIN_WEEKS);
  }

  // Minimum send threshold in units (pass carton qty when known).
  function computeMinSend(ctnQty, avgMonthBranch) {
    if (ctnQty && ctnQty > 0) {
      return Math.ceil(ctnQty / 2);
    }
    if (avgMonthBranch && avgMonthBranch > 0) {
      const avgWeek = avgMonthBranch / WEEKS_IN_MONTH;
      return Math.max(Math.ceil(avgWeek), MIN_SEND_FALLBACK_UNITS - 1);
    }
    return MIN_SEND_FALLBACK_UNITS;
  }

  // Sync freshness classification.
  //   Returns { ageMinutes, level: 'fresh'|'warn'|'block'|'none', message }
  function classifySyncAge(endedAt) {
    if (!endedAt) {
      return { ageMinutes: null, level: 'none', message: 'No sync runs yet' };
    }
    const ms = Date.now() - new Date(endedAt).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins > SYNC_BLOCK_MINUTES) {
      return {
        ageMinutes: mins,
        level: 'block',
        message: 'Stock data is ' + formatAge(mins) + ' old — Cin7 sync has stalled. Recommendations hidden until data refreshes.'
      };
    }
    if (mins > SYNC_WARN_MINUTES) {
      return {
        ageMinutes: mins,
        level: 'warn',
        message: 'Stock data is ' + formatAge(mins) + ' old — last sync may have failed. Verify before acting.'
      };
    }
    return { ageMinutes: mins, level: 'fresh', message: 'Stock data from ' + formatAge(mins) + ' ago' };
  }

  // Partial-sync detector.
  //   syncRun: { status, products_synced, stock_rows_synced }
  //   Returns { ok, warn, message }
  function classifySyncRun(syncRun) {
    if (!syncRun) return { ok: false, warn: false, message: null };
    if (syncRun.status === 'running') {
      return { ok: false, warn: true, message: 'Sync in progress — results may be incomplete.' };
    }
    if (syncRun.status !== 'success') {
      return { ok: false, warn: true, message: 'Last sync failed (' + (syncRun.status || 'unknown') + ') — using previous snapshot.' };
    }
    const products = syncRun.products_synced || 0;
    const stockRows = syncRun.stock_rows_synced || 0;
    if (SYNC_MIN_PRODUCTS && products > 0 && products < SYNC_MIN_PRODUCTS) {
      return {
        ok: false, warn: true,
        message: 'Partial sync: only ' + products + ' products synced (expected ≥ ' + SYNC_MIN_PRODUCTS + '). Some SKUs may be missing.'
      };
    }
    if (SYNC_MIN_STOCK_ROWS && stockRows > 0 && stockRows < SYNC_MIN_STOCK_ROWS) {
      return {
        ok: false, warn: true,
        message: 'Partial sync: only ' + stockRows + ' stock rows synced (expected ≥ ' + SYNC_MIN_STOCK_ROWS + '). Some locations may be missing.'
      };
    }
    return { ok: true, warn: false, message: null };
  }

  // Shared smart carton rounder.
  // Returns { qty, rounded: 'none'|'exact'|'up'|'down'|'partial' }
  function smartCartonRound(suggestedQty, ctnQty, canSendQty, targetQty) {
    if (!ctnQty || ctnQty <= 0) return { qty: suggestedQty, rounded: 'none' };
    const roundedUp = Math.ceil(suggestedQty / ctnQty) * ctnQty;
    const roundedDown = Math.floor(suggestedQty / ctnQty) * ctnQty;
    if (suggestedQty === roundedUp) return { qty: suggestedQty, rounded: 'exact' };
    const maxAcceptable = targetQty ? targetQty * CARTON_ROUND_UP_MAX_RATIO : Infinity;
    if (roundedUp <= canSendQty && roundedUp <= maxAcceptable) return { qty: roundedUp, rounded: 'up' };
    if (roundedDown > 0) return { qty: roundedDown, rounded: 'down' };
    return { qty: suggestedQty, rounded: 'partial' };
  }

  function formatAge(mins) {
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm';
    const h = Math.floor(mins / 60);
    if (h < 24) return h + 'h ' + (mins % 60) + 'm';
    return Math.floor(h / 24) + 'd';
  }

  // ──────────────────────────────────────────────────────────────────
  // EXPORT
  // ──────────────────────────────────────────────────────────────────
  window.ReplenishmentConfig = {
    // constants
    WEEKS_IN_MONTH,
    BRANCH_TARGET_WEEKS,
    MAIN_MIN_WEEKS,
    LEAD_TIME_DAYS,
    CARTON_ROUND_UP_MAX_RATIO,
    CARTON_MODE_MAX_MONTHS,
    MIN_SEND_FALLBACK_UNITS,
    SYNC_WARN_MINUTES,
    SYNC_BLOCK_MINUTES,
    SYNC_MIN_STOCK_ROWS,
    SYNC_MIN_PRODUCTS,
    COVER_CRITICAL_DAYS,
    COVER_WARNING_DAYS,
    COVER_OK_DAYS,
    EXCLUDED_NAME_PATTERNS,
    CIN7_LOCATION_MAP,
    BRANCHES,

    // helpers
    isExcludedProduct,
    computeBranchTarget,
    computeMainSafety,
    computeMinSend,
    classifySyncAge,
    classifySyncRun,
    smartCartonRound,
    formatAge
  };
})();
