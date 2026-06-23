import type {
  CalendarEvent,
  CalendarProvider,
  ConfigFieldSchema,
  IntegrationContext,
  MailAttachment,
  MailProvider,
  ProbeResult,
  ProviderDefinition,
  ResolvedConnection,
} from '../types'
import { getAccessToken, isOAuthConnected } from '../oauth'

// Google adapters (Gmail send + Calendar) over OAuth2. Hosts are HARDCODED. The
// pure builders (buildGmailRaw, mapCalendarEvent) are offline-unit-testable; the
// live calls go through getAccessToken (auto-refresh). Ships as TWO connections
// (mail + calendar) because the registry resolves one adapter per category.

const GMAIL_BASE = 'https://gmail.googleapis.com'
const GCAL_BASE = 'https://www.googleapis.com'
const TIMEOUT = 12000

const OAUTH_FIELDS: ConfigFieldSchema[] = [
  { key: 'client_id', label: 'OAuth Client-ID', type: 'string', required: true },
  { key: 'client_secret', label: 'OAuth Client-Secret', type: 'string', secret: true, required: true },
  {
    key: 'redirect_uri',
    label: 'Redirect-URI (exakt wie in Google Cloud hinterlegt)',
    type: 'string',
    required: true,
    placeholder: 'https://crm.example.com/api/integrations/oauth/callback',
  },
]

function rfc2047(s: string): string {
  // Encode a header value as an RFC 2047 encoded-word only when it has non-ASCII.
  return /[^\x00-\x7F]/.test(s) ? `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=` : s
}

// Strip CR/LF (and other control chars) from a value going into a raw MIME
// header — otherwise a newline in `to`/`from`/`subject` (which can originate from
// lead/document data) could inject extra headers (Bcc:, etc.). Header-injection guard.
function headerSafe(s: string): string {
  return (s ?? '').replace(/[\r\n\t\f\v\0]+/g, ' ').trim()
}

// Fixed MIME boundary — fine for our short text + a PDF (collision with content
// is effectively impossible). Constant keeps buildGmailRaw pure + unit-testable.
const GMAIL_BOUNDARY = 'ol_mixed_b7f3a1c9e2'

/** Build a base64url RFC-2822 message for the Gmail send API. Pure. With
 *  attachments it emits a multipart/mixed message; otherwise a plain text part. */
export function buildGmailRaw(msg: {
  to: string
  from?: string
  subject: string
  text: string
  attachments?: MailAttachment[]
}): string {
  const baseHeaders = [
    msg.from ? `From: ${headerSafe(msg.from)}` : null,
    `To: ${headerSafe(msg.to)}`,
    `Subject: ${rfc2047(headerSafe(msg.subject))}`,
    'MIME-Version: 1.0',
  ]
  const atts = msg.attachments ?? []
  let raw: string
  if (atts.length === 0) {
    raw =
      [...baseHeaders, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: 8bit']
        .filter(Boolean)
        .join('\r\n') +
      '\r\n\r\n' +
      msg.text
  } else {
    let body =
      `--${GMAIL_BOUNDARY}\r\n` +
      'Content-Type: text/plain; charset="UTF-8"\r\n' +
      'Content-Transfer-Encoding: 8bit\r\n\r\n' +
      msg.text +
      '\r\n'
    for (const a of atts) {
      const b64 = a.content.toString('base64').replace(/(.{76})/g, '$1\r\n')
      body +=
        `--${GMAIL_BOUNDARY}\r\n` +
        `Content-Type: ${a.contentType ?? 'application/octet-stream'}; name="${a.filename}"\r\n` +
        'Content-Transfer-Encoding: base64\r\n' +
        `Content-Disposition: attachment; filename="${a.filename}"\r\n\r\n` +
        b64 +
        '\r\n'
    }
    body += `--${GMAIL_BOUNDARY}--`
    raw =
      [...baseHeaders, `Content-Type: multipart/mixed; boundary="${GMAIL_BOUNDARY}"`].filter(Boolean).join('\r\n') +
      '\r\n\r\n' +
      body
  }
  return Buffer.from(raw, 'utf8').toString('base64url')
}

/** Map a generic calendar event to the Google Calendar event body. Pure. */
export function mapCalendarEvent(input: {
  title: string
  start: string
  end: string
  description?: string
  attendees?: string[]
}) {
  return {
    summary: input.title,
    description: input.description ?? undefined,
    start: { dateTime: input.start },
    end: { dateTime: input.end },
    attendees: input.attendees?.map((e) => ({ email: e })),
  }
}

async function googleFetch(base: string, path: string, token: string, body: unknown): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    })
  } catch {
    throw new Error('Google ist nicht erreichbar.')
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string } }
  if (!res.ok) throw new Error(`Google-Fehler: ${json?.error?.message ?? res.status}`)
  return json
}

function connectedProbe(connId: number): ProbeResult {
  const s = isOAuthConnected(connId)
  return s.connected
    ? { ok: true, detail: s.account_email ? `Verbunden als ${s.account_email}` : 'Verbunden' }
    : { ok: false, detail: 'Konto nicht verbunden — bitte „Verbinden" klicken.' }
}

class GoogleMail implements MailProvider {
  readonly category = 'mail' as const
  readonly provider = 'google'
  private readonly connId: number
  constructor(conn: ResolvedConnection) {
    this.connId = conn.id
  }
  async probe(): Promise<ProbeResult> {
    return connectedProbe(this.connId)
  }
  async send(
    msg: { to: string; from: string; subject: string; text: string; attachments?: MailAttachment[] },
    _ctx: IntegrationContext,
  ) {
    const token = await getAccessToken(this.connId)
    const r = await googleFetch(GMAIL_BASE, '/gmail/v1/users/me/messages/send', token, { raw: buildGmailRaw(msg) })
    return { messageId: String(r.id ?? '') }
  }
}

class GoogleCalendar implements CalendarProvider {
  readonly category = 'calendar' as const
  readonly provider = 'google'
  private readonly connId: number
  constructor(conn: ResolvedConnection) {
    this.connId = conn.id
  }
  async probe(): Promise<ProbeResult> {
    return connectedProbe(this.connId)
  }
  async createEvent(
    input: { title: string; start: string; end: string; description?: string; attendees?: string[] },
    _ctx: IntegrationContext,
  ): Promise<CalendarEvent> {
    const token = await getAccessToken(this.connId)
    const r = await googleFetch(GCAL_BASE, '/calendar/v3/calendars/primary/events', token, mapCalendarEvent(input))
    return { id: String(r.id ?? ''), title: input.title, start: input.start, end: input.end, url: (r.htmlLink as string) ?? null }
  }
}

export const googleMailDefinition: ProviderDefinition<MailProvider> = {
  category: 'mail',
  provider: 'google',
  label: 'Google (Gmail)',
  configSchema: OAUTH_FIELDS,
  build: (conn) => new GoogleMail(conn),
}

export const googleCalendarDefinition: ProviderDefinition<CalendarProvider> = {
  category: 'calendar',
  provider: 'google',
  label: 'Google Kalender',
  configSchema: OAUTH_FIELDS,
  build: (conn) => new GoogleCalendar(conn),
}
