import { randomBytes } from 'node:crypto'
import { db, type OAuthTokenRow, type OAuthPendingRow } from '../db'
import { encryptSecret, decryptSecret } from '../secrets'

// Reusable OAuth2 (authorization-code + refresh) framework for connections that
// authenticate via OAuth — Google and Microsoft Graph. Access + refresh tokens
// are AES-256-GCM ciphertext at rest (secrets.ts); they are never returned to the
// client. Hosts are HARDCODED per provider (only the Microsoft {tenant} path
// segment is operator-configurable, never a free-form host). The pure functions
// (buildAuthorizeUrl, parseIdTokenEmail, scopesFor) are offline-unit-testable;
// the network calls (exchangeCode, getAccessToken) sit behind them.

export interface OAuthSpec {
  provider: string
  authUrl: (tenant?: string) => string
  tokenUrl: (tenant?: string) => string
  /** Extra params appended to the authorize URL (e.g. offline access). */
  authParams: Record<string, string>
}

export const GOOGLE_SPEC: OAuthSpec = {
  provider: 'google',
  authUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: () => 'https://oauth2.googleapis.com/token',
  // offline → refresh token; consent → re-issue refresh token on reconnect.
  authParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
}

export const MSGRAPH_SPEC: OAuthSpec = {
  provider: 'microsoft',
  authUrl: (t) => `https://login.microsoftonline.com/${t || 'common'}/oauth2/v2.0/authorize`,
  tokenUrl: (t) => `https://login.microsoftonline.com/${t || 'common'}/oauth2/v2.0/token`,
  authParams: { prompt: 'consent' },
}

export function specForProvider(provider: string): OAuthSpec | null {
  return provider === 'google' ? GOOGLE_SPEC : provider === 'microsoft' ? MSGRAPH_SPEC : null
}

/** Delegated scopes per provider + category. Pure. */
export function scopesFor(provider: string, category: string): string[] {
  if (provider === 'google') {
    const base = ['openid', 'email']
    if (category === 'mail') return [...base, 'https://www.googleapis.com/auth/gmail.send']
    if (category === 'calendar') return [...base, 'https://www.googleapis.com/auth/calendar.events']
    return base
  }
  if (provider === 'microsoft') {
    const base = ['openid', 'email', 'offline_access']
    if (category === 'mail') return [...base, 'https://graph.microsoft.com/Mail.Send']
    if (category === 'calendar') return [...base, 'https://graph.microsoft.com/Calendars.ReadWrite']
    return base
  }
  return ['openid', 'email']
}

/** Build the provider authorize URL. Pure. */
export function buildAuthorizeUrl(
  spec: OAuthSpec,
  opts: { clientId: string; redirectUri: string; scope: string[]; state: string; tenant?: string },
): string {
  const u = new URL(spec.authUrl(opts.tenant))
  const p = u.searchParams
  p.set('client_id', opts.clientId)
  p.set('redirect_uri', opts.redirectUri)
  p.set('response_type', 'code')
  p.set('scope', opts.scope.join(' '))
  p.set('state', opts.state)
  for (const [k, v] of Object.entries(spec.authParams)) p.set(k, v)
  return u.toString()
}

/** Extract the account email from an OIDC id_token (no signature check needed —
 *  the token arrives over TLS straight from the provider's token endpoint). Pure. */
export function parseIdTokenEmail(idToken: string | null | undefined): string | null {
  if (!idToken) return null
  const parts = idToken.split('.')
  if (parts.length < 2) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>
    return (payload.email as string) ?? (payload.preferred_username as string) ?? (payload.upn as string) ?? null
  } catch {
    return null
  }
}

export interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  id_token?: string
}

/** Token-endpoint error that preserves the provider's OAuth2 `error` code (e.g.
 *  'invalid_grant') so callers can react to a revoked/expired refresh token —
 *  the German-wrapped message often doesn't contain the raw code. */
export class OAuthTokenError extends Error {
  readonly code: string | null
  constructor(message: string, code: string | null) {
    super(message)
    this.name = 'OAuthTokenError'
    this.code = code
  }
}

async function postToken(spec: OAuthSpec, tenant: string | undefined, body: Record<string, string>): Promise<TokenResponse> {
  let res: Response
  try {
    res = await fetch(spec.tokenUrl(tenant), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(12000),
    })
  } catch {
    throw new OAuthTokenError('OAuth-Server nicht erreichbar.', null)
  }
  const json = (await res.json().catch(() => ({}))) as TokenResponse & { error?: string; error_description?: string }
  if (!res.ok) {
    throw new OAuthTokenError(`OAuth-Fehler: ${json.error_description || json.error || res.status}`, json.error ?? null)
  }
  return json
}

/** Exchange an authorization code for tokens (live). */
export function exchangeCode(
  spec: OAuthSpec,
  opts: { clientId: string; clientSecret: string; code: string; redirectUri: string; tenant?: string },
): Promise<TokenResponse> {
  return postToken(spec, opts.tenant, {
    grant_type: 'authorization_code',
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
  })
}

interface ConnAuth {
  provider: string
  config: Record<string, unknown>
  secrets: Record<string, string>
}

function loadConnAuth(connectionId: number): ConnAuth | null {
  const row = db
    .prepare('SELECT provider, config, credentials_enc FROM integration_connections WHERE id = ?')
    .get(connectionId) as { provider: string; config: string; credentials_enc: string | null } | undefined
  if (!row) return null
  let config: Record<string, unknown> = {}
  let secrets: Record<string, string> = {}
  try {
    config = JSON.parse(row.config)
  } catch {
    /* keep {} */
  }
  const dec = decryptSecret(row.credentials_enc)
  if (dec) {
    try {
      secrets = JSON.parse(dec)
    } catch {
      /* keep {} */
    }
  }
  return { provider: row.provider, config, secrets }
}

/** Persist tokens (encrypted). Keeps the existing refresh token if a refresh
 *  response omits one (Google only returns it on the first consent). */
export function storeTokens(
  connectionId: number,
  t: { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; account_email?: string | null },
): void {
  const now = Math.floor(Date.now() / 1000)
  const existing = db
    .prepare('SELECT refresh_token_enc, account_email, scope FROM oauth_tokens WHERE connection_id = ?')
    .get(connectionId) as { refresh_token_enc: string | null; account_email: string | null; scope: string | null } | undefined
  const access_enc = t.access_token ? encryptSecret(t.access_token) : null
  // Google omits refresh_token + scope on a refresh response — preserve them.
  const refresh_enc = t.refresh_token ? encryptSecret(t.refresh_token) : (existing?.refresh_token_enc ?? null)
  const email = t.account_email ?? existing?.account_email ?? null
  const scope = t.scope ?? existing?.scope ?? null
  const expires_at = t.expires_in != null ? now + Number(t.expires_in) : null
  db.prepare(
    `INSERT INTO oauth_tokens (connection_id, account_email, access_token_enc, refresh_token_enc, expires_at, scope)
     VALUES (@cid, @email, @a, @r, @e, @s)
     ON CONFLICT(connection_id) DO UPDATE SET
       account_email = excluded.account_email,
       access_token_enc = excluded.access_token_enc,
       refresh_token_enc = excluded.refresh_token_enc,
       expires_at = excluded.expires_at,
       scope = excluded.scope,
       updated_at = datetime('now')`,
  ).run({ cid: connectionId, email, a: access_enc, r: refresh_enc, e: expires_at, s: scope })
}

/** Get a valid access token for a connection, refreshing if expired (live). */
export async function getAccessToken(connectionId: number): Promise<string> {
  const conn = loadConnAuth(connectionId)
  if (!conn) throw new Error('Verbindung nicht gefunden.')
  const spec = specForProvider(conn.provider)
  if (!spec) throw new Error('Kein OAuth-Anbieter für diese Verbindung.')
  const row = db.prepare('SELECT * FROM oauth_tokens WHERE connection_id = ?').get(connectionId) as unknown as
    | OAuthTokenRow
    | undefined
  if (!row || !row.refresh_token_enc) throw new Error('Konto nicht verbunden — bitte zuerst verbinden.')
  const now = Math.floor(Date.now() / 1000)
  const access = decryptSecret(row.access_token_enc)
  if (access && row.expires_at && row.expires_at > now + 60) return access // still valid

  const clientId = String(conn.config.client_id ?? '')
  const clientSecret = conn.secrets.client_secret ?? ''
  const tenant = conn.config.tenant ? String(conn.config.tenant) : undefined
  const refresh = decryptSecret(row.refresh_token_enc)
  if (!clientId || !clientSecret || !refresh) throw new Error('OAuth-Zugangsdaten unvollständig.')
  let t: TokenResponse
  try {
    t = await postToken(spec, tenant, {
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: clientId,
      client_secret: clientSecret,
    })
  } catch (e) {
    // A revoked/expired refresh token (invalid_grant) is terminal: refreshing will
    // never succeed again. Clear the dead tokens so isOAuthConnected() flips to
    // false (the UI stops showing "connected" and offers a reconnect) and flag the
    // connection so the operator sees why. Other errors (server down, timeout) are
    // transient — leave the tokens in place and just propagate.
    if (e instanceof OAuthTokenError && e.code === 'invalid_grant') {
      disconnectOAuth(connectionId)
      markConnectionAuthExpired(connectionId)
      throw new Error('OAuth-Konto getrennt — Token abgelaufen oder zurückgezogen. Bitte neu verbinden.')
    }
    throw e
  }
  storeTokens(connectionId, t)
  if (!t.access_token) throw new Error('Kein Access-Token erhalten.')
  return t.access_token
}

/** Flag a connection as needing reconnect after its refresh token died. Inline
 *  DB write (not registry.setStatus) to avoid an import cycle. */
function markConnectionAuthExpired(connectionId: number): void {
  try {
    db.prepare(
      "UPDATE integration_connections SET status = 'error', status_detail = ?, updated_at = datetime('now') WHERE id = ?",
    ).run('Konto-Verbindung abgelaufen — bitte neu verbinden.', connectionId)
  } catch {
    // status is advisory; never let a logging-style write break the call path.
  }
}

/** True if a connection has a stored refresh token (i.e. is connected). */
export function isOAuthConnected(connectionId: number): { connected: boolean; account_email: string | null } {
  const row = db
    .prepare('SELECT account_email, refresh_token_enc FROM oauth_tokens WHERE connection_id = ?')
    .get(connectionId) as { account_email: string | null; refresh_token_enc: string | null } | undefined
  return { connected: !!row?.refresh_token_enc, account_email: row?.account_email ?? null }
}

export function disconnectOAuth(connectionId: number): void {
  db.prepare('DELETE FROM oauth_tokens WHERE connection_id = ?').run(connectionId)
}

const PENDING_TTL_MIN = 10

/**
 * Mint a single-use CSRF state, persist it with the connection's redirect_uri,
 * and return the provider authorize URL for the operator to open. Throws German
 * if the connection isn't OAuth or its client_id/redirect_uri aren't saved yet.
 */
export function createPendingAuthUrl(connectionId: number): string {
  const row = db
    .prepare('SELECT provider, category, config FROM integration_connections WHERE id = ?')
    .get(connectionId) as { provider: string; category: string; config: string } | undefined
  if (!row) throw new Error('Verbindung nicht gefunden.')
  const spec = specForProvider(row.provider)
  if (!spec) throw new Error('Diese Verbindung nutzt kein OAuth.')
  let config: Record<string, unknown> = {}
  try {
    config = JSON.parse(row.config)
  } catch {
    /* keep {} */
  }
  const clientId = String(config.client_id ?? '')
  const redirectUri = String(config.redirect_uri ?? '')
  if (!clientId || !redirectUri) {
    throw new Error('OAuth-Client-ID und Redirect-URI müssen zuerst gespeichert werden.')
  }
  const tenant = config.tenant ? String(config.tenant) : undefined
  const state = randomBytes(24).toString('hex')
  db.prepare('INSERT INTO oauth_pending (state, connection_id, redirect_uri) VALUES (?, ?, ?)').run(
    state,
    connectionId,
    redirectUri,
  )
  return buildAuthorizeUrl(spec, {
    clientId,
    redirectUri,
    scope: scopesFor(row.provider, row.category),
    state,
    tenant,
  })
}

/**
 * Handle the OAuth callback: validate the single-use state, exchange the code
 * (binding the exact redirect_uri that was sent), and persist encrypted tokens.
 * Throws German 'Ungültiger oder abgelaufener OAuth-State.' on a bad/expired state.
 */
export async function completeCallback(
  state: string,
  code: string,
): Promise<{ connection_id: number; account_email: string | null }> {
  db.prepare(`DELETE FROM oauth_pending WHERE created_at <= datetime('now', '-${PENDING_TTL_MIN} minutes')`).run()
  const pending = db.prepare('SELECT * FROM oauth_pending WHERE state = ?').get(state) as unknown as
    | OAuthPendingRow
    | undefined
  if (!pending) throw new Error('Ungültiger oder abgelaufener OAuth-State.')
  db.prepare('DELETE FROM oauth_pending WHERE state = ?').run(state) // single-use
  const conn = loadConnAuth(pending.connection_id)
  if (!conn) throw new Error('Verbindung nicht gefunden.')
  const spec = specForProvider(conn.provider)
  if (!spec) throw new Error('Kein OAuth-Anbieter.')
  const clientId = String(conn.config.client_id ?? '')
  const clientSecret = conn.secrets.client_secret ?? ''
  const tenant = conn.config.tenant ? String(conn.config.tenant) : undefined
  const t = await exchangeCode(spec, { clientId, clientSecret, code, redirectUri: pending.redirect_uri, tenant })
  const account_email = parseIdTokenEmail(t.id_token)
  storeTokens(pending.connection_id, { ...t, account_email })
  return { connection_id: pending.connection_id, account_email }
}
