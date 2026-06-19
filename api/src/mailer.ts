import './env'
import nodemailer from 'nodemailer'
import { resolveSMTPConfig } from './secrets'
import type { OutreachRow, LeadRow, SettingsRow } from './db'

// Outreach delivery. Sending is the one truly outward-facing action in OpenLeads,
// so it is deliberately constrained: only a human-approved draft can be sent, and
// every message gets an Impressum + a one-line opt-out appended automatically
// (UWG §7 identification + Art. 21 DSGVO Widerspruch). Composition is a pure
// function so it can be unit-tested without a mail server.

// Resolves live on each access: DB (Settings UI) wins, else the matching .env
// var (see secrets.ts). The password is decrypted from the DB ciphertext or
// read from SMTP_PASS. Getters keep every `SMTP.host` / `SMTP.pass` call site
// unchanged.
export const SMTP = {
  get host(): string {
    return resolveSMTPConfig().host
  },
  get port(): number {
    return resolveSMTPConfig().port
  },
  get user(): string {
    return resolveSMTPConfig().user
  },
  get pass(): string {
    return resolveSMTPConfig().pass
  },
  get secure(): boolean {
    return resolveSMTPConfig().secure // true = 465/TLS, false = STARTTLS
  },
  get from(): string {
    return resolveSMTPConfig().from
  },
}

export function isMailConfigured(): boolean {
  return !!(SMTP.host && SMTP.from)
}

/** Build the Impressum/opt-out footer from the business profile. */
export function buildFooter(s: SettingsRow): string {
  const impressum = [
    s.business_name,
    s.owner,
    [s.address, [s.zip, s.city].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    [s.phone ? `Tel: ${s.phone}` : null, s.email].filter(Boolean).join(' · '),
    s.tax_id ? `Steuernr./USt-IdNr.: ${s.tax_id}` : null,
  ]
    .filter(Boolean)
    .join('\n')
  return (
    `\n\n— — —\n${impressum}\n\n` +
    `Falls Sie keine weitere Nachricht von uns wünschen, genügt eine kurze Antwort ` +
    `mit „kein Interesse" — wir kontaktieren Sie dann nicht erneut und löschen Ihre ` +
    `Daten auf Wunsch (Art. 21 DSGVO).`
  )
}

/** Replace the {{absender_*}} placeholders the AI leaves for the system to fill. */
export function fillPlaceholders(body: string, s: SettingsRow): string {
  const impressum = [s.business_name, s.owner, s.address, [s.zip, s.city].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join('\n')
  return body
    .replace(/\{\{\s*absender_name\s*\}\}/g, s.owner ?? s.business_name ?? '')
    .replace(/\{\{\s*absender_firma\s*\}\}/g, s.business_name ?? '')
    .replace(/\{\{\s*absender_impressum\s*\}\}/g, impressum)
}

export interface ComposedEmail {
  to: string
  from: string
  subject: string
  text: string
}

/** Pure composition: resolve placeholders + append the compliance footer. */
export function composeOutreachEmail(o: OutreachRow, lead: LeadRow, s: SettingsRow): ComposedEmail {
  if (!lead.email) throw new Error('Lead hat keine E-Mail-Adresse.')
  const subject = o.subject?.trim() || `Kurze Anfrage zu Ihrer Website`
  const body = fillPlaceholders(o.body, s) + buildFooter(s)
  return { to: lead.email, from: SMTP.from || s.email || '', subject, text: body }
}

/** Actually send via SMTP. Separated from composition so tests stay offline. */
export async function sendMail(email: ComposedEmail): Promise<{ messageId: string }> {
  if (!isMailConfigured()) throw new Error('SMTP ist nicht konfiguriert (SMTP_HOST/SMTP_FROM).')
  const transport = nodemailer.createTransport({
    host: SMTP.host,
    port: SMTP.port,
    secure: SMTP.secure,
    auth: SMTP.user ? { user: SMTP.user, pass: SMTP.pass } : undefined,
  })
  const info = await transport.sendMail({
    from: email.from,
    to: email.to,
    subject: email.subject,
    text: email.text,
  })
  return { messageId: info.messageId }
}
