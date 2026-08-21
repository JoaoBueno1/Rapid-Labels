"""Getting a Microsoft Graph token, by whichever door is open.

Two doors, one function — but for the workbook API only one of them exists, and
that is not a policy we can get lifted:

    PATCH  /workbook/worksheets/{id}/range   Application: Not supported.
    POST   /workbook/createSession           Application: Not supported.

Microsoft's own permission tables, verified 2026-08-13. Both list delegated
`Files.ReadWrite` and nothing else. So an app-only token — even with
`Sites.Selected` perfectly consented AND the per-site grant in place — can read
the file and never write a cell. It fails at the first PATCH, long after
everything looks configured, which is the worst possible place to find out.

Hence `WORKBOOK_MODE` below. This module used to prefer app-only and fall back,
so that the day consent landed, production would switch by itself. For anything
that touches a workbook that preference is a live grenade: consent arriving
would silently flip delivery onto the door that cannot write, and every nightly
run would start failing on a change nobody made.

  delegated (the only door for workbooks)
      A human signs in once with device code; after that a refresh token renews
      itself on every run. Costs what it costs, and it should be said plainly:
      the stored token can read and write everything that account can reach,
      which is far more than the three tabs. Use a dedicated automation account,
      not a person's — the workbook's version history records whoever it is,
      daily, on seven files, and a personal account takes the job with it when
      it leaves.

  app-only (fine for everything that is NOT a workbook)
      client credentials + `Sites.Selected`, scoped to one site, no refresh
      token to babysit. Correct for reading drive items, listing folders,
      resolving a file by path. Just not for editing cells.

Azure AD rotates the refresh token on every use. A headless job that does not
persist the new one locks itself out after a single run — hence the Supabase
token store rather than a GitHub secret.
"""
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from .. import supabase

# Not secrets — the app registration is single-tenant and these identify it, not
# authorise anything. Overridable for a second tenant or a test app.
TENANT = os.environ.get('GRAPH_TENANT_ID', '59ec4380-0cab-455d-a6e2-f10314801005')
CLIENT = os.environ.get('GRAPH_CLIENT_ID', '8c4aa84e-db46-4d6c-b629-922e7ca22243')

AUTHORITY = 'https://login.microsoftonline.com'

# `.All` and not plain `Files.ReadWrite`: the least-privileged permission in
# Microsoft's table is `Files.ReadWrite`, but delegated `Files.ReadWrite` covers
# only the signed-in user's own OneDrive. These workbooks live in a SharePoint
# document library, which needs `.All`. Anyone trying to trim this scope to the
# documented minimum will get a token that cannot see the files.
DELEGATED_SCOPES = 'https://graph.microsoft.com/Files.ReadWrite.All offline_access'

# What `token()` uses when the caller does not say. See the module docstring:
# workbook range writes have no app-only path, so delivery must never fall onto
# one. Callers that only touch driveItems may pass mode='auto' or 'app'.
WORKBOOK_MODE = 'delegated'

_CACHE = {}          # one token per process; a run does many calls


def _env(name):
    """Real env wins, then the repo .env — same order as engine/supabase.py."""
    if os.environ.get(name):
        return os.environ[name]
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..', '..'))
    path = os.path.join(root, '.env')
    if os.path.exists(path):
        with open(path, encoding='utf-8') as fh:
            for line in fh:
                m = re.match(r'\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$', line)
                if m and m.group(1) == name:
                    return m.group(2).strip().strip('"').strip("'")
    return None


def _post_token(form):
    body = urllib.parse.urlencode(form).encode()
    req = urllib.request.Request(f'{AUTHORITY}/{TENANT}/oauth2/v2.0/token',
                                 data=body, method='POST')
    req.add_header('Content-Type', 'application/x-www-form-urlencoded')
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return 200, json.loads(r.read())
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {'error': 'http', 'error_description': raw.decode('utf-8', 'replace')[:400]}


# ─────────────────────────────────────────────────────────────────────────────
# app-only
# ─────────────────────────────────────────────────────────────────────────────
def _app_token():
    secret = _env('GRAPH_CLIENT_SECRET')
    if not secret:
        return None
    status, data = _post_token({
        'client_id': CLIENT, 'client_secret': secret,
        'scope': 'https://graph.microsoft.com/.default',
        'grant_type': 'client_credentials'})
    if status == 200 and data.get('access_token'):
        return data
    # Not fatal: a secret can be present while consent is still missing, which
    # is exactly today's state. Say so and let the caller fall through.
    print(f"  app-only token unavailable: {str(data.get('error_description') or data)[:180]}")
    return None


# ─────────────────────────────────────────────────────────────────────────────
# delegated
# ─────────────────────────────────────────────────────────────────────────────
def _store(sb=None):
    return sb or supabase.Client(schema='public')


def load_refresh_token(sb=None):
    try:
        rows = _store(sb).rpc('excel_graph_token_get', {}) or []
    except SystemExit as e:
        # PGRST202 = the function is not there, which means one thing only.
        if 'PGRST202' in str(e):
            raise SystemExit(
                'The delivery schema is not deployed yet.\n'
                '  Run db/003_graph_delivery.sql in the Supabase SQL editor.\n'
                '  (Rapid Labels has no _exec_sql helper — it is a paste, not a script.)')
        raise
    return rows[0] if rows else None


def save_refresh_token(refresh_token, account=None, scopes=None, sb=None):
    _store(sb).rpc('excel_graph_token_set', {
        'p_refresh_token': refresh_token, 'p_account': account, 'p_scopes': scopes})


def _delegated_token(sb=None):
    row = load_refresh_token(sb)
    if not row:
        raise SystemExit(
            'No delegated refresh token stored.\n'
            '  Run:  python -m engine graph-login\n'
            '  (one browser sign-in as joao@rapidled.com.au; after that it renews itself)')

    status, data = _post_token({
        'client_id': CLIENT, 'grant_type': 'refresh_token',
        'refresh_token': row['refresh_token'], 'scope': DELEGATED_SCOPES})

    if status != 200 or not data.get('access_token'):
        desc = str(data.get('error_description') or data)[:400]
        raise SystemExit(
            f'Delegated refresh FAILED: {desc}\n'
            '  The stored token is dead — expired, revoked, or invalidated by a\n'
            '  Conditional Access policy. Re-run: python -m engine graph-login')

    # Rotation. Persist before returning: if the run dies after using the token
    # but before saving, the next run authenticates with a spent one.
    if data.get('refresh_token') and data['refresh_token'] != row['refresh_token']:
        save_refresh_token(data['refresh_token'], row.get('account'), DELEGATED_SCOPES, sb)
    return data


# ─────────────────────────────────────────────────────────────────────────────
def token(sb=None, mode=None):
    """An access token. Delegated by default — see the module docstring.

    mode='delegated' (the default) is the only door the workbook API accepts.
    mode='app' forces client credentials; mode='auto' prefers app-only and falls
    back. Both are correct for driveItem calls and wrong for editing cells, so
    neither is the default. The probe uses them to report which doors are open.
    """
    mode = mode or os.environ.get('GRAPH_AUTH_MODE') or WORKBOOK_MODE
    cached = _CACHE.get(mode)
    if cached and cached['expires_at'] > time.time() + 120:
        return cached['access_token']

    data = None
    if mode in ('auto', 'app'):
        data = _app_token()
        if data:
            print('  auth: app-only (client credentials)')
            print('  NOTE: app-only cannot PATCH a workbook range. Fine for driveItem')
            print('        calls; if this token is about to write cells, that is a bug.')
    if data is None:
        if mode == 'app':
            raise SystemExit('GRAPH_AUTH_MODE=app but no app-only token could be obtained.')
        data = _delegated_token(sb)
        print('  auth: delegated (refresh token)')

    _CACHE[mode] = {'access_token': data['access_token'],
                    'expires_at': time.time() + int(data.get('expires_in', 3600))}
    return data['access_token']


# ─────────────────────────────────────────────────────────────────────────────
# bootstrap — interactive, run once by a human
# ─────────────────────────────────────────────────────────────────────────────
def device_login(sb=None):
    """Device code sign-in, then store the refresh token. Needs a browser.

    Requires 'Allow public client flows = Yes' on the app registration. That
    switch belongs to whoever owns the app, not to a tenant administrator.
    """
    body = urllib.parse.urlencode({'client_id': CLIENT, 'scope': DELEGATED_SCOPES}).encode()
    req = urllib.request.Request(f'{AUTHORITY}/{TENANT}/oauth2/v2.0/devicecode',
                                 data=body, method='POST')
    req.add_header('Content-Type', 'application/x-www-form-urlencoded')
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            dc = json.loads(r.read())
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8', 'replace')
        if 'AADSTS7000218' in raw or 'client_assertion' in raw:
            raise SystemExit(
                'Device code refused: the app is not a public client.\n'
                '  Entra → App registrations → Rapid labels - Excel sync →\n'
                '  Authentication → Advanced settings → Allow public client flows = Yes')
        raise SystemExit(f'device code request failed: {raw[:400]}')

    print(f"\n{dc['message']}\n")
    deadline = time.time() + int(dc.get('expires_in', 900))
    interval = int(dc.get('interval', 5))
    while time.time() < deadline:
        time.sleep(interval)
        status, tk = _post_token({
            'client_id': CLIENT,
            'grant_type': 'urn:ietf:params:oauth:grant-type:device_code',
            'device_code': dc['device_code']})
        if status == 200:
            if not tk.get('refresh_token'):
                raise SystemExit('Signed in but got no refresh_token — is offline_access in the scopes?')
            account = _account_of(tk['access_token'])
            save_refresh_token(tk['refresh_token'], account, DELEGATED_SCOPES, sb)
            print(f'  stored. signed in as {account or "(unknown)"}')
            print('  from here the nightly run renews it on its own.')
            return True
        err = tk.get('error')
        if err == 'authorization_pending':
            continue
        if err == 'slow_down':
            interval += 5
            continue
        desc = str(tk.get('error_description', err))
        if 'AADSTS65001' in desc:
            raise SystemExit(
                'The tenant blocks user consent for this app.\n'
                '  Delegated is out too — admin consent is the only door left.\n'
                '  Fall back to writing the OneDrive-synced local copy.')
        raise SystemExit(f'sign-in failed: {desc[:400]}')
    raise SystemExit('timed out waiting for sign-in.')


def _account_of(access_token):
    """Who did we just become? Purely for the audit trail; never fatal."""
    req = urllib.request.Request('https://graph.microsoft.com/v1.0/me?$select=userPrincipalName')
    req.add_header('Authorization', f'Bearer {access_token}')
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read()).get('userPrincipalName')
    except Exception:
        return None
