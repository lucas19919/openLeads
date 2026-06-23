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

// Microsoft Graph adapters (Outlook mail + calendar) over OAuth2. Host is
// HARDCODED (graph.microsoft.com); only the {tenant} of the login host is config
// (handled in oauth.ts). Pure builders are offline-testable; live calls go
// through getAccessToken. Ships as two connections (mail + calendar).

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
const TIMEOUT = 12000

const OAUTH_FIELDS: ConfigFieldSchema[] = [
  { key: 'client_id', label: 'Anwendungs-ID (client_id)', type: 'string', required: true },
  { key: 'client_secret', label: 'Client-Secret (Wert)', type: 'string', secret: true, required: true },
  { key: 'tenant', label: 'Verzeichnis (Tenant) — oder „common"', type: 'string', placeholder: 'common' },
  {
    key: 'redirect_uri',
    label: 'Redirect-URI (exakt wie in Entra hinterlegt)',
    type: 'string',
    required: true,
    placeholder: 'https://crm.example.com/api/integrations/oauth/callback',
  },
]

/** Graph dateTime wants a local-style "YYYY-MM-DDTHH:mm:ss" + a timeZone field. */
function graphDateTime(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19)
}

/** Build the Graph /me/sendMail body. Pure. Adds fileAttachments when present. */
export function buildGraphSendMailBody(msg: {
  to: string
  subject: string
  text: string
  attachments?: MailAttachment[]
}) {
  const attachments = msg.attachments?.length
    ? msg.attachments.map((a) => ({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: a.filename,
        contentType: a.contentType ?? 'application/octet-stream',
        contentBytes: a.content.toString('base64'),
      }))
    : undefined
  return {
    message: {
      subject: msg.subject,
      body: { contentType: 'Text', content: msg.text },
      toRecipients: [{ emailAddress: { address: msg.to } }],
      attachments, // undefined → dropped by JSON.stringify
    },
    saveToSentItems: true,
  }
}

/** Map a generic calendar event to the Graph event body. Pure. */
export function mapGraphEvent(input: {
  title: string
  start: string
  end: string
  description?: string
  attendees?: string[]
}) {
  return {
    subject: input.title,
    body: { contentType: 'Text', content: input.description ?? '' },
    start: { dateTime: graphDateTime(input.start), timeZone: 'UTC' },
    end: { dateTime: graphDateTime(input.end), timeZone: 'UTC' },
    attendees: input.attendees?.map((e) => ({ emailAddress: { address: e }, type: 'required' })),
  }
}

async function graphPost(path: string, token: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  let res: Response
  try {
    res = await fetch(`${GRAPH_BASE}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    })
  } catch {
    throw new Error('Microsoft Graph ist nicht erreichbar.')
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: { message?: string } }
  if (!res.ok) throw new Error(`Graph-Fehler: ${json?.error?.message ?? res.status}`)
  return { status: res.status, json }
}

function connectedProbe(connId: number): ProbeResult {
  const s = isOAuthConnected(connId)
  return s.connected
    ? { ok: true, detail: s.account_email ? `Verbunden als ${s.account_email}` : 'Verbunden' }
    : { ok: false, detail: 'Konto nicht verbunden — bitte „Verbinden" klicken.' }
}

class MsGraphMail implements MailProvider {
  readonly category = 'mail' as const
  readonly provider = 'microsoft'
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
    // /me/sendMail returns 202 with no body — synthesise a messageId marker.
    await graphPost('/me/sendMail', token, buildGraphSendMailBody(msg))
    return { messageId: `graph-${Date.now()}` }
  }
}

class MsGraphCalendar implements CalendarProvider {
  readonly category = 'calendar' as const
  readonly provider = 'microsoft'
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
    const { json } = await graphPost('/me/events', token, mapGraphEvent(input))
    return { id: String(json.id ?? ''), title: input.title, start: input.start, end: input.end, url: (json.webLink as string) ?? null }
  }
}

export const msgraphMailDefinition: ProviderDefinition<MailProvider> = {
  category: 'mail',
  provider: 'microsoft',
  label: 'Microsoft 365 (Outlook)',
  configSchema: OAUTH_FIELDS,
  build: (conn) => new MsGraphMail(conn),
}

export const msgraphCalendarDefinition: ProviderDefinition<CalendarProvider> = {
  category: 'calendar',
  provider: 'microsoft',
  label: 'Microsoft 365 Kalender',
  configSchema: OAUTH_FIELDS,
  build: (conn) => new MsGraphCalendar(conn),
}
