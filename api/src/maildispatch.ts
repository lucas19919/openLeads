import { resolve } from './integrations/registry'
import { sendMail, isMailConfigured, type ComposedEmail, type MailAttachment } from './mailer'
import type { MailProvider } from './integrations/types'

/** True if mail can be sent at all: an external mail integration is active, or
 *  the built-in SMTP mailer is configured. Use this for pre-send guards instead
 *  of isMailConfigured() alone, which only knows about SMTP. */
export function mailReady(): boolean {
  const provider = resolve('mail') as MailProvider | null
  if (provider && provider.provider !== 'smtp') return true
  return isMailConfigured()
}

// Single outbound-mail entry point. Sends through the ACTIVE mail integration
// (Integrationen → E-Mail) when one is configured, falling back to the built-in
// SMTP mailer otherwise. The SMTP adapter itself delegates to that same mailer,
// so the default install behaves exactly as before — this only adds the ability
// to route mail through Gmail/Graph when an admin activates one.
//
// It does NOT touch composition: callers still build the body (incl. the UWG §7
// Impressum / Art. 21 opt-out footer for outreach) before handing it here, and
// the "only an approved draft may be sent" gate stays in the outreach route.
// Lives in its own module (not mailer.ts) to avoid an import cycle: the SMTP
// adapter imports the mailer, so the mailer must not import the registry.

export async function deliverMail(
  email: ComposedEmail,
  opts: { attachments?: MailAttachment[]; actor?: string | null } = {},
): Promise<{ messageId: string; via: string }> {
  const provider = resolve('mail') as MailProvider | null

  // No active mail integration, or it's the built-in SMTP wrapper → use the mailer
  // directly (full attachment support, unchanged path).
  if (!provider || provider.provider === 'smtp') {
    const r = await sendMail(email, opts.attachments)
    return { ...r, via: 'smtp' }
  }

  // An external provider (Gmail/Graph) is active — send through it. If the account
  // isn't connected the adapter throws a clear German error, which the route
  // surfaces; we deliberately do NOT silently fall back to SMTP, since the admin
  // chose this provider as the active one.
  const r = await provider.send(
    { to: email.to, from: email.from, subject: email.subject, text: email.text, attachments: opts.attachments },
    { actor: opts.actor ?? null },
  )
  return { ...r, via: provider.provider }
}
