import type { Context, Next, MiddlewareHandler } from 'hono'

// A tiny fixed-window rate limiter (in-memory). Good enough for a single-node
// self-hosted deployment — it protects the expensive AI endpoints from runaway
// loops or a compromised session hammering the model. No external store.

interface Window {
  count: number
  resetAt: number
}

export function rateLimit(opts: { windowMs: number; max: number; key?: (c: Context) => string }): MiddlewareHandler {
  const hits = new Map<string, Window>()
  const keyOf = opts.key ?? ((c: Context) => c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'global')

  // Opportunistic cleanup so the map can't grow unbounded.
  function sweep(now: number) {
    if (hits.size < 1000) return
    for (const [k, w] of hits) if (w.resetAt <= now) hits.delete(k)
  }

  return async (c: Context, next: Next) => {
    const now = Date.now()
    sweep(now)
    const key = keyOf(c)
    let w = hits.get(key)
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + opts.windowMs }
      hits.set(key, w)
    }
    w.count++
    if (w.count > opts.max) {
      const retry = Math.ceil((w.resetAt - now) / 1000)
      c.header('Retry-After', String(retry))
      return c.json({ error: `Zu viele Anfragen — bitte in ${retry}s erneut versuchen.` }, 429)
    }
    await next()
  }
}
