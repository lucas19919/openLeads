import { sendMail, isMailConfigured, type ComposedEmail, type MailAttachment } from './mailer'

// Single outbound-mail entry point. Sends through the built-in SMTP mailer. (The
// pluggable mail-integration layer was removed when the app was streamlined; this
// stays as the one place mail leaves the system so callers don't import the mailer
// directly and a future provider could slot back in here.)
//
// It does NOT touch composition: callers still build the body (incl. the UWG §7
// Impressum / Art. 21 opt-out footer for outreach) before handing it here, and
// the "only an approved draft may be sent" gate stays in the outreach route.

/** True if mail can be sent at all (SMTP configured). */
export function mailReady(): boolean {
  return isMailConfigured()
}

export async function deliverMail(
  email: ComposedEmail,
  opts: { attachments?: MailAttachment[]; actor?: string | null } = {},
): Promise<{ messageId: string; via: string }> {
  const r = await sendMail(email, opts.attachments)
  return { ...r, via: 'smtp' }
}
