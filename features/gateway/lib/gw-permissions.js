/**
 * Gateway — capability check.
 *
 * This app has no authentication (docs/RUNBOOKS.md:19: "Authentication: None").
 * Pretending otherwise would be worse than saying so, so this module does two
 * honest things instead of inventing a login:
 *
 *   1. It names the capabilities separately, so the code reads
 *      `can(req, 'gateway.override_fifo')` rather than scattering implicit
 *      assumptions about who may do what. When a real identity model arrives,
 *      only this file changes.
 *
 *   2. It reads an optional GATEWAY_ROLES map from the environment. Where the
 *      map is absent — which is the state today — every capability is granted
 *      and the process says so ONCE at boot. A silent allow-all is how a
 *      permission model rots; a loud one is a to-do that keeps announcing
 *      itself.
 *
 * No email addresses are hardcoded. GATEWAY_ROLES is JSON:
 *   {"joao":["*"],"warehouse":["gateway.view","gateway.transfer.*"]}
 * matched against the x-gw-user header, which is attribution, NOT proof.
 */

const CAPABILITIES = [
  'gateway.view',
  'gateway.transfer.create',
  'gateway.transfer.edit',
  'gateway.transfer.link_cin7',
  'gateway.transfer.complete',
  'gateway.transfer.cancel',
  'gateway.lot.receive',
  'gateway.lot.adjust',
  'gateway.override_fifo',
  'gateway.reconcile',
  'gateway.import',
  'gateway.settings',
];

let ROLES = null;
let warned = false;

function roles() {
  if (ROLES !== null) return ROLES;
  const raw = (process.env.GATEWAY_ROLES || '').trim();
  if (!raw) { ROLES = {}; return ROLES; }
  try {
    ROLES = JSON.parse(raw);
  } catch (e) {
    console.warn('[gateway] GATEWAY_ROLES is not valid JSON — ignoring it:', e.message);
    ROLES = {};
  }
  return ROLES;
}

function userOf(req) {
  return (req.headers['x-gw-user'] || '').toString().trim() || null;
}

/** Does `grant` cover `cap`? Supports '*' and 'gateway.transfer.*'. */
function covers(grant, cap) {
  if (grant === '*') return true;
  if (grant === cap) return true;
  if (grant.endsWith('.*')) return cap.startsWith(grant.slice(0, -1));
  return false;
}

function can(req, cap) {
  const map = roles();
  if (!Object.keys(map).length) {
    if (!warned) {
      warned = true;
      console.warn(
        '[gateway] GATEWAY_ROLES is not set — every Gateway capability is open to ' +
        'anyone who can reach the server. This matches the rest of the app, which ' +
        'has no auth, but it is a gap, not a design.');
    }
    return true;
  }
  const granted = map[userOf(req)] || map['*'] || [];
  return granted.some(g => covers(g, cap));
}

/** Express guard. Returns true when the request may proceed. */
function require_(req, res, cap) {
  if (can(req, cap)) return true;
  res.status(403).json({
    success: false,
    error: `Not permitted: ${cap}`,
    hint: 'Set the x-gw-user header to a user listed in GATEWAY_ROLES.',
  });
  return false;
}

module.exports = { CAPABILITIES, can, require: require_, userOf };
