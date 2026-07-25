import type { Hono } from 'hono'
import { TOKEN_SCOPES, type TokenScope } from '../db'
import { createApiToken, listApiTokens, revokeApiToken } from '../auth'
import { audit } from '../audit'
import { requireAuth, type Vars } from './middleware'

// API tokens for headless callers — the CLI, its MCP server, and cron jobs.
// Each user manages their own: a token can never reach further than the person
// who minted it, and revoking it is one row deletion.

const MAX_TOKENS_PER_USER = 25

export function registerTokenRoutes(app: Hono<{ Variables: Vars }>): void {
  app.get('/api/tokens', requireAuth, (c) => c.json({ tokens: listApiTokens(c.get('user').id) }))

  // The plaintext token is in this response and nowhere else, ever again.
  app.post('/api/tokens', requireAuth, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const user = c.get('user')

    const name = typeof b.name === 'string' ? b.name.trim() : ''
    if (!name) return c.json({ error: 'Name fehlt.' }, 400)
    if (name.length > 80) return c.json({ error: 'Name zu lang (max. 80 Zeichen).' }, 400)

    const scope = (b.scope ?? 'write') as TokenScope
    if (!TOKEN_SCOPES.includes(scope)) return c.json({ error: 'Ungültiger Scope.' }, 400)

    // Optional lifetime. Unattended workflows usually want none; a token handed
    // to someone else usually should have one.
    let expiresAt: string | null = null
    if (b.expires_days != null && b.expires_days !== '') {
      const days = Number(b.expires_days)
      if (!Number.isFinite(days) || days <= 0 || days > 3650) {
        return c.json({ error: 'Laufzeit muss zwischen 1 und 3650 Tagen liegen.' }, 400)
      }
      expiresAt = new Date(Date.now() + days * 86_400_000).toISOString()
    }

    if (listApiTokens(user.id).length >= MAX_TOKENS_PER_USER) {
      return c.json({ error: `Maximal ${MAX_TOKENS_PER_USER} Tokens pro Konto.` }, 409)
    }

    const created = createApiToken(user.id, name, scope, expiresAt)
    audit({
      actor: user.username,
      action: 'token.create',
      entity: 'api_token',
      entityId: created.id,
      detail: { name, scope, prefix: created.prefix, expires_at: expiresAt },
    })
    return c.json({ token: created.token, id: created.id, prefix: created.prefix }, 201)
  })

  app.delete('/api/tokens/:id', requireAuth, (c) => {
    const id = Number(c.req.param('id'))
    const user = c.get('user')
    if (!revokeApiToken(user.id, id)) return c.json({ error: 'not found' }, 404)
    audit({ actor: user.username, action: 'token.revoke', entity: 'api_token', entityId: id })
    return c.json({ ok: true })
  })
}
