# Logistics Dashboards (Feature)

Guardrails
- Do not modify existing production code.
- HTML/CSS/JS are feature-scoped under this folder.
- Mock-only data for now. No Supabase calls yet.

Feature flag
- Gate access externally; or toggle via console: `window.FEATURE_LOGISTICS_DASHBOARDS_V1 = true`.

Pages
- warehouse-movements.html + warehouse-movements.js
- invoicing-monitor.html + invoicing-monitor.js
- deliveries-couriers.html + deliveries-couriers.js

Replace mocks with real data later by swapping repository functions in each `*.js` file.
