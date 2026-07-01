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
  // BRANCH_TARGET_WEEKS: default branches cover, used as fallback when ABC
  // tier can't be determined. ABC tiers below override this per SKU.
  const BRANCH_TARGET_WEEKS = 6;

  // ABC velocity tiers — top movers need more cover, tail less.
  // Manager mega-overstocks A-class SKUs (RSS, RQC, R-GPO2-WH) at ~24
  // weeks. Sistema-wise we go conservative — A gets 12 weeks (3x the tail),
  // not 24. Manager can still override per SKU via restock_setup later.
  //
  // Classification (rank by total network demand desc):
  //   Top 20% by demand  → A → 12 weeks target
  //   Next 30%           → B → 8  weeks
  //   Remaining 50%      → C → 6  weeks (same as legacy default)
  // Tuned 2026-05-13: A=10 (was 12) — 12 produced overshoots on top movers
  // where manager actually keeps 6-8 wk; 10 keeps the boost without the over.
  const ABC_TARGET_WEEKS = { A: 10, B: 8, C: 6 };
  const ABC_PERCENTILES  = { A_CUTOFF: 0.20, B_CUTOFF: 0.50 };

  // MAIN_MIN_WEEKS: safety stock Main/Gateway must keep before shipping.
  //   8 weeks ≈ supplier lead time (4-6 wks) + processing buffer (2 wks).
  //   Below this, Main itself becomes the bottleneck.
  //
  //   Critical: this multiplies the avg returned by pickMainAvg(), which
  //   prefers avg_sales_main (true Main customer demand) over
  //   avg_mth_main (which includes interstate transfers and is inflated).
  //   Without that preference, 8 × inflated_avg blocks all top movers.
  const MAIN_MIN_WEEKS = 8;

  // ──────────────────────────────────────────────────────────────────
  // CARTON ROUNDING
  // ──────────────────────────────────────────────────────────────────
  // Carton round-up uses TWO caps — both must be satisfied:
  //
  //   1. Ratio cap: roundedUp ≤ targetQty × CARTON_ROUND_UP_MAX_RATIO
  //      Falls back when avg/branch_avail aren't available. Used as guard.
  //
  //   2. Months cap (preferred when avg known): post-send branch coverage
  //      ≤ CARTON_ROUND_UP_MAX_MONTHS months of branch demand.
  //      → "Don't let a carton round-up push the branch past 2 months stock."
  //      This is the easier-to-verify intuition for ops review.
  //
  // Examples:
  //   avg 58, branch 8, ctn 50 → max post-stock = 116, max qty = 108.
  //     roundedUp 100 ≤ 108 → ships 100 (~1.9 months cover) ✓
  //   avg 17, branch 24, ctn 100 → max post-stock = 34, max qty = 10.
  //     roundedUp 100 > 10 → reject. Sends raw 3 (then min-send may block).
  const CARTON_ROUND_UP_MAX_RATIO = 2;
  // 4 months mirrors manager behaviour: for slow-mover SKUs where Main holds
  // abundant stock, ops routinely ships a full carton even when it covers 3-6
  // months of branch demand (avoids partial-carton inefficiency).
  // Verified against real Sydney TR 2026-05-12: SKUs like R-PMB, R-WPI220,
  // R6232-BK-TRI were full-carton sent at 4-7 months cover.
  const CARTON_ROUND_UP_MAX_MONTHS = 4;

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
  const SYNC_WARN_MINUTES = 240;  // 4h — soft amber heads-up; recommendations still shown
  const SYNC_BLOCK_MINUTES = 480; // 8h — hard block only; below this the data is considered fine to act on

  // Expected rows per successful sync — flags partial failures.
  // Set to ~60% of the live catalog so a partial sync (well below normal)
  // raises a warning. Live catalog is currently:
  //   stock_snapshot ≈ 14,200 rows  → threshold 8,000
  //   products       ≈ 10,700 rows  → threshold 5,000
  // Was 500 / 100 — way too low to detect partial syncs.
  const SYNC_MIN_STOCK_ROWS = 8000;
  const SYNC_MIN_PRODUCTS = 5000;

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
  //   First pattern: SKU contains the word "carton" as its own token.
  //   Second pattern: catches variant SKUs like R-WPI220-Carton50,
  //     R-SLGPO2-WH-Carton100 — bundle/multipack codes that we don't
  //     replenish independently. Without this, the carton variants got
  //     planned alongside the base SKU and double-counted.
  // Patterns matched against the SKU code itself.
  const EXCLUDED_SKU_PATTERNS = [
    // Carton/multipack bundle SKUs (existing)
    /\bcarton\b/i,
    /[-_ ]carton\d+/i,
    // V1 suffix — V1 is always the legacy version, never replenished
    //   Sucessor is the same SKU without the -V1 (e.g. R-GPO2-WH-V1 → R-GPO2-WH)
    /[-_]v1$/i
  ];

  // Patterns matched against the product NAME (description).
  // These need a product-name lookup, so callers must pass the name.
  const EXCLUDED_NAME_PATTERNS = [
    // Per-metre products (LED strips, fairy lights, extrusions sold per m).
    //   Tracked by length, not unit qty — don't auto-replenish.
    //   Captures: "per 1m", "per 10M", "per 1 metre", "/m"
    /\bper\s+\d+\s*m\b/i,
    /\bper\s*metres?\b/i,
    /\bper\s*meters?\b/i,
    /\/\s*m\b/i
  ];

  // Explicit SKU exclusions — exact match.
  // Sources audited 2026-05-13 against Cin7 status + last_modified.
  //
  // Exceptions kept (NOT excluded):
  //   - R6071-BK-CW and R6071-BK-CW-V2 — V2 has "anti corrosive", distinct product
  //   - R1160-WH-V2 base siblings — CCT variants are distinct products
  //   - Variants >12W (R107X-15W-...) — outside the 6-12W unified range, kept
  const EXCLUDED_SKUS = new Set([
    // ── Bases replaced by -V2 sibling (V2 is the newer revision) ──
    'R-SMI10',         // → R-SMI10-V2
    'R-TVPAL-F',       // → R-TVPAL-F-V2
    'R2340-WW-10',     // → R2340-WW-10-V2  (also Cin7-deprecated)
    'R2332-WW-10',     // → R2332-WW-10-V2  (also Cin7-deprecated)
    'R2360-WW-10',     // → R2360-WW-10-V2  (also Cin7-deprecated)
    'R2352-CW-10',     // → R2352-CW-10-V2  (V2 8mm redesign)
    'R2360-CW-10',     // → R2360-CW-10-V2  (V2 8mm redesign)
    'R2332-WW-15',     // → R2332-WW-15-V2  (V2 8mm redesign)

    // ── R107X family wattage variants 6-12W (unified <base>-<rest> exists) ──
    // R1069
    'R1069-WH-12W-WW-60',
    // R1071 (Architectural Deep Set COB)
    'R1071-A-BK-12W-CW-60',
    'R1071-A-BK-12W-WW-60',
    'R1071-A-WH-12W-CW-60',
    'R1071-A-WH-12W-WW-60',
    'R1071-BK-12W-WW-60',
    'R1071-BK-9W-CW-60',
    'R1071-WH-12W-CW-60',
    'R1071-WH-12W-WW-60',
    'R1071-WH-6W-WW-60',
    'R1071-WH-9W-CW-60',
    'R1071-WH-9W-WW-60',
    // R1072
    'R1072-WH-12W-WW-60',
    'R1072-WH-9W-WW-60',
    // R1073
    'R1073-WH-12W-CW-60',
    'R1073-WH-9W-WW-60',
    // R1074
    'R1074-BK-12W-CW-60',
    // R1075
    'R1075-BK-12W-WW-60',
    'R1075-WH-12W-WW-24',
    'R1075-WH-12W-WW-60',
    'R1075-WH-6W-CW-60',
    'R1075-WH-6W-WW-60',
    'R1075-WH-9W-WW-60',
    // R1076
    'R1076-BK-12W-WW-60',
    'R1076-WH-12W-CW-60',
    'R1076-WH-12W-WW-60',
    'R1076-WH-6W-WW-60',
    // R1077
    'R1077-WH-12W-WW-24',
    'R1077-WH-12W-WW-60',
    'R1077-WH-6W-WW-24',
    'R1077-WH-9W-WW-60',
    // R1078
    'R1078-WH-12W-WW-60',
    'R1078-WH-6W-WW-60',
    'R1078-WH-9W-WW-24',
    'R1078-WH-9W-WW-60',
    // R1079
    'R1079-WH-12W-CW-60',
    'R1079-WH-12W-WW-60',
    // R107M (modules)
    'R107M-12W-CW-60',
    'R107M-12W-CW-60-S',
    'R107M-12W-WW-60',
    'R107M-6W-CW-60',
    'R107M-9W-CW-60'
  ]);

  // productCode = SKU (required). productName = description (optional but
  // recommended — enables per-metre/by-length filtering).
  function isExcludedProduct(productCode, productName) {
    if (!productCode) return true;
    const sku = String(productCode);
    // 1. Exact SKU exclusion list (case-insensitive)
    if (EXCLUDED_SKUS.has(sku) || EXCLUDED_SKUS.has(sku.toUpperCase())) return true;
    // 2. SKU pattern (carton variants, -V1 legacy)
    if (EXCLUDED_SKU_PATTERNS.some(rx => rx.test(sku))) return true;
    // 3. Name pattern (per-metre, etc.) — only if name was supplied
    if (productName && EXCLUDED_NAME_PATTERNS.some(rx => rx.test(String(productName)))) return true;
    return false;
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

  // avgField     = warehouse-shipped avg (legacy, used as fallback)
  // avgRepField  = sales-rep-based avg (preferred when > 0). See pickAvg().
  const BRANCHES = [
    { code: 'SYD', name: 'Sydney',         avgField: 'avg_mth_sydney',         avgRepField: 'avg_rep_sydney' },
    { code: 'MEL', name: 'Melbourne',      avgField: 'avg_mth_melbourne',      avgRepField: 'avg_rep_melbourne' },
    { code: 'BNE', name: 'Brisbane',       avgField: 'avg_mth_brisbane',       avgRepField: 'avg_rep_brisbane' },
    { code: 'CNS', name: 'Cairns',         avgField: 'avg_mth_cairns',         avgRepField: 'avg_rep_cairns' },
    { code: 'CFS', name: 'Coffs Harbour',  avgField: 'avg_mth_coffs_harbour',  avgRepField: 'avg_rep_coffs_harbour' },
    { code: 'HBA', name: 'Hobart',         avgField: 'avg_mth_hobart',         avgRepField: 'avg_rep_hobart' },
    { code: 'SCS', name: 'Sunshine Coast', avgField: 'avg_mth_sunshine_coast', avgRepField: 'avg_rep_sunshine_coast' }
  ];

  // Field names for Main warehouse avg.
  const MAIN_AVG_FIELD = 'avg_mth_main';
  const MAIN_AVG_REP_FIELD = 'avg_rep_main';

  // ──────────────────────────────────────────────────────────────────
  // HELPERS
  // ──────────────────────────────────────────────────────────────────

  // Pick the right avg for a branch: prefer the sales-rep based avg when it
  // exists and is > 0 (it reflects actual demand at the branch, not just what
  // was shipped from there). Fall back to the legacy warehouse-shipped avg.
  //
  // avgRow is a row from branch_avg_monthly_sales.
  // branchInfo is one of the entries in BRANCHES (or { avgField, avgRepField }).
  function pickAvg(avgRow, branchInfo) {
    if (!avgRow || !branchInfo) return 0;
    const rep = Number(avgRow[branchInfo.avgRepField] || 0);
    if (rep > 0) return rep;
    return Number(avgRow[branchInfo.avgField] || 0);
  }

  // Main-warehouse avg for SAFETY calculation.
  //
  // Preference order:
  //   1. avg_rep_main   — manager-curated, sales-rep based (truest Main demand)
  //   2. avg_sales_main — auto-computed: sales-only portion (excludes
  //                       interstate transfers OUT of Main)
  //   3. avg_mth_main   — total movement out of Main (INCLUDES transfers,
  //                       so it's network-wide demand → inflated for safety)
  //
  // The first two reflect what Main actually sells to its own customers and
  // is the correct base for "how much Main must keep to cover supplier lead
  // time". avg_mth_main is fallback only.
  function pickMainAvg(avgRow) {
    if (!avgRow) return 0;
    const rep = Number(avgRow[MAIN_AVG_REP_FIELD] || 0);
    if (rep > 0) return rep;
    const sales = Number(avgRow.avg_sales_main || 0);
    if (sales > 0) return sales;
    return Number(avgRow[MAIN_AVG_FIELD] || 0);
  }

  // Target: N weeks of branch cover (N from the ABC tier or a custom override).
  // Returns integer units.
  function computeBranchTarget(avgMonth, weeks) {
    if (!avgMonth || avgMonth <= 0) return 0;
    const w = weeks || BRANCH_TARGET_WEEKS;
    const avgWeek = avgMonth / WEEKS_IN_MONTH;
    return Math.ceil(avgWeek * w);
  }

  // Classify SKUs into A/B/C tiers based on total network demand.
  // Takes an array of avg-rows (one per SKU with avg_*_<branch> columns).
  // Returns a Map<sku, 'A'|'B'|'C'>.
  function computeAbcRanks(avgRows) {
    const branchFields = BRANCHES.flatMap(b => [b.avgRepField, b.avgField])
                                  .concat(['avg_rep_main', 'avg_sales_main', 'avg_mth_main']);
    const totals = [];
    for (const r of (avgRows || [])) {
      let total = 0;
      for (const b of BRANCHES) {
        const v = Number(r[b.avgRepField] || 0) || Number(r[b.avgField] || 0);
        total += v;
      }
      if (total > 0) totals.push({ sku: r.product, total });
    }
    totals.sort((a, b) => b.total - a.total);
    const n = totals.length;
    const cutA = Math.ceil(n * ABC_PERCENTILES.A_CUTOFF);
    const cutB = Math.ceil(n * ABC_PERCENTILES.B_CUTOFF);
    const ranks = new Map();
    totals.forEach((row, i) => {
      const tier = i < cutA ? 'A' : i < cutB ? 'B' : 'C';
      ranks.set(row.sku, tier);
    });
    return ranks;
  }

  function targetWeeksForTier(tier) {
    return ABC_TARGET_WEEKS[tier] || BRANCH_TARGET_WEEKS;
  }

  // Main safety stock: minimum Main must keep.
  // Caller passes Main's sales-only avg (see pickMainAvg); the formula is
  // strict 8-weeks-of-demand, no cap — Main is the hub and must hold its
  // supplier lead-time buffer or the network breaks.
  function computeMainSafety(avgMonthMain) {
    if (!avgMonthMain || avgMonthMain <= 0) return 0;
    const avgWeek = avgMonthMain / WEEKS_IN_MONTH;
    return Math.ceil(avgWeek * MAIN_MIN_WEEKS);
  }

  // Minimum send threshold in units.
  //
  // Rationale (2026-05-13 simplification):
  //   The minimum below which we won't bother sending — applies only when
  //   the branch ALREADY has stock (top-up case). The check is independent
  //   of carton qty (half-carton rule produced odd blocks for medium-ctn
  //   SKUs like 18-40 units). Single rule: at least 1 week of branch demand,
  //   or the absolute fallback floor.
  //
  //   For oversold branches the caller bypasses this entirely.
  function computeMinSend(ctnQty, avgMonthBranch) {
    if (avgMonthBranch && avgMonthBranch > 0) {
      const avgWeek = avgMonthBranch / WEEKS_IN_MONTH;
      return Math.max(MIN_SEND_FALLBACK_UNITS - 1, Math.ceil(avgWeek));
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
  //
  // opts: {
  //   avgMonthBranch:    enables month-cap (post-send coverage ≤ N months)
  //   branchAvailable:   used by month-cap to compute post-send stock
  //   mainAbundant:      true if Main has >12 months of its own demand →
  //                      relaxes month-cap from 4 → 8 for slow-mover (avg<5)
  //                      large-carton (ctn≥50) SKUs. Mimics manager behaviour
  //                      of shipping full ctn for slow movers when Main is loaded.
  // }
  function smartCartonRound(suggestedQty, ctnQty, canSendQty, targetQty, opts) {
    if (!ctnQty || ctnQty <= 0) return { qty: suggestedQty, rounded: 'none' };
    const roundedUp = Math.ceil(suggestedQty / ctnQty) * ctnQty;
    const roundedDown = Math.floor(suggestedQty / ctnQty) * ctnQty;
    if (suggestedQty === roundedUp) return { qty: suggestedQty, rounded: 'exact' };

    // Cap 1: ratio of target (always applied as a guard).
    let maxAcceptable = targetQty ? targetQty * CARTON_ROUND_UP_MAX_RATIO : Infinity;

    // Cap 2 (preferred when avg known): post-send coverage ≤ N months.
    // The cap floor is CARTON_ROUND_UP_MAX_MONTHS (4) but it RISES with
    // targetWeeks. If user sets target=20w (≈4.6 months), the cap must
    // be at least that much — otherwise the round-up could never reach
    // the user-requested target. Without this, target>17w made the round
    // logic systematically reject and the to_send list went empty.
    if (opts && opts.avgMonthBranch && opts.avgMonthBranch > 0) {
      const branchAvail = Math.max(0, opts.branchAvailable || 0);
      // Slow-mover bias unchanged: low-avg + large ctn + Main abundant → 8mo
      let maxMonths = CARTON_ROUND_UP_MAX_MONTHS;
      const slowMoverLargeCtn = opts.avgMonthBranch < 5 && ctnQty >= 50;
      if (slowMoverLargeCtn && opts.mainAbundant) maxMonths = 8;
      // Scale up with user's chosen target — never cap BELOW target.
      if (opts.targetWeeks) {
        const targetMonths = opts.targetWeeks / WEEKS_IN_MONTH;
        if (targetMonths > maxMonths) maxMonths = targetMonths;
      }
      const maxPostStock = Math.ceil(opts.avgMonthBranch * maxMonths);
      const monthsCapMaxQty = Math.max(0, maxPostStock - branchAvail);
      if (monthsCapMaxQty < maxAcceptable) maxAcceptable = monthsCapMaxQty;
    }

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
    CARTON_ROUND_UP_MAX_RATIO,
    CARTON_ROUND_UP_MAX_MONTHS,
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
    MAIN_AVG_FIELD,
    MAIN_AVG_REP_FIELD,

    // constants
    ABC_TARGET_WEEKS,
    ABC_PERCENTILES,

    // helpers
    isExcludedProduct,
    pickAvg,
    pickMainAvg,
    computeBranchTarget,
    computeAbcRanks,
    targetWeeksForTier,
    computeMainSafety,
    computeMinSend,
    classifySyncAge,
    classifySyncRun,
    smartCartonRound,
    formatAge
  };
})();
