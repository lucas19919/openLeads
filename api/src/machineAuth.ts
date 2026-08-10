import './env'
import { timingSafeEqual } from 'node:crypto'
import type { Context, Next } from 'hono'

// Auth for the /api/machine/* surface: one static bearer token provisioned via
// env, for external agent platforms and automations that hold a single shared
// machine secret instead of a personal API token (auth.ts). Requests act as a
// fixed machine principal — never as a user account — so lead events and the
// audit trail always show that automation made the change.
//
// Fail closed: with CRM_MACHINE_TOKEN unset (or empty) the whole surface
// answers 401, no matter what a caller presents.

/** Actor recorded in lead events and the audit trail for machine writes. */
export function machinePrincipal(): string {
  return process.env.CRM_MACHINE_PRINCIPAL?.trim() || 'machine:mcp'
}

/** Constant-time check of a presented secret against CRM_MACHINE_TOKEN. */
function tokenMatches(presented: string): boolean {
  const expected = process.env.CRM_MACHINE_TOKEN
  if (!expected) return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Gate for every machine route (the data-free health probe aside). */
export async function requireMachine(c: Context, next: Next) {
  const header = c.req.header('authorization')
  const [scheme, value] = header?.split(' ') ?? []
  const presented = scheme?.toLowerCase() === 'bearer' && value ? value : undefined
  if (!presented || !tokenMatches(presented)) return c.json({ error: 'unauthorized' }, 401)
  await next()
}
