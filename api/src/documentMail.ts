import { getSettings, type FullDocument } from './documents'
import { renderDocumentPdf, pdfFilename } from './pdf'
import { SMTP } from './mailer'
import { deliverMail } from './maildispatch'

// Mailing an issued document to the client. Lifted out of the route so the human
// API and the (approval-gated) machine API send the exact same letter — one
// wording, one attachment, one place to change it.
//
// This is a one-way door: once the mail is accepted by the relay it cannot be
// recalled. Callers must have established authority to send before calling —
// an interactive human click, or a consumed Freigabe (see approvals.ts).

export class DocumentMailError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export interface SentMail {
  to: string
  messageId: string | undefined
  via: string
}

/** Render the PDF and hand it to the mailer. Throws DocumentMailError. */
export async function mailDocument(doc: FullDocument, actor: string): Promise<SentMail> {
  if (!doc.number) throw new DocumentMailError('Nur ausgestellte Dokumente können versendet werden.')
  if (!doc.client_email) throw new DocumentMailError('Kein Empfänger (E-Mail) am Dokument hinterlegt.')
  const s = getSettings()

  let pdf: Buffer
  try {
    pdf = await renderDocumentPdf(doc, s)
  } catch (e) {
    throw new DocumentMailError('PDF konnte nicht erstellt werden: ' + (e as Error).message, 500)
  }

  const label = doc.kind === 'rechnung' ? 'Rechnung' : 'Angebot'
  const greeting = doc.client_name
    ? `Sehr geehrte Damen und Herren bei ${doc.client_name},`
    : 'Sehr geehrte Damen und Herren,'
  const body =
    `${greeting}\n\nanbei erhalten Sie ${label === 'Rechnung' ? 'unsere Rechnung' : 'unser Angebot'} ${doc.number} als PDF.\n\n` +
    `Mit freundlichen Grüßen\n${s.business_name ?? ''}`
  const email = {
    to: doc.client_email,
    from: SMTP.from || s.email || '',
    subject: `${label} ${doc.number}`,
    text: body,
  }

  try {
    const { messageId, via } = await deliverMail(email, {
      attachments: [{ filename: pdfFilename(doc), content: pdf, contentType: 'application/pdf' }],
      actor,
    })
    return { to: email.to, messageId, via }
  } catch (e) {
    throw new DocumentMailError((e as Error).message, 502)
  }
}
