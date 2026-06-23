import type {
  IntegrationContext,
  MailAttachment,
  MailProvider,
  ProbeResult,
  ProviderDefinition,
} from '../types'
import { sendMail, isMailConfigured } from '../../mailer'

// Wraps the EXISTING SMTP mailer so the one outward integration OpenLeads already
// has unifies under the adapter interface — without changing its call sites and
// WITHOUT creating a bypass around its UWG §7 / Art. 21 gates (those live in the
// outreach send route, which still calls the mailer directly). SMTP credentials
// continue to live in Settings (secrets.ts resolveSMTPConfig), so this adapter
// needs no connection secrets; activating a 'mail/smtp' connection just marks it
// the live mail provider.

class SmtpAdapter implements MailProvider {
  readonly category = 'mail' as const
  readonly provider = 'smtp'

  async probe(): Promise<ProbeResult> {
    return isMailConfigured()
      ? { ok: true }
      : { ok: false, detail: 'SMTP ist nicht konfiguriert (SMTP_HOST/SMTP_FROM).' }
  }

  async send(
    msg: { to: string; from: string; subject: string; text: string; attachments?: MailAttachment[] },
    _ctx: IntegrationContext,
  ): Promise<{ messageId: string }> {
    return sendMail(
      { to: msg.to, from: msg.from, subject: msg.subject, text: msg.text },
      msg.attachments,
    )
  }
}

export const smtpDefinition: ProviderDefinition<MailProvider> = {
  category: 'mail',
  provider: 'smtp',
  label: 'SMTP (eingebauter Mailversand)',
  configSchema: [],
  build: () => new SmtpAdapter(),
}
