# Compliance notes

OpenLeads is built for operators in the DACH market who care about invoices and data protection. This is **not** legal advice — treat it as a map of what the software does, then confirm with your Steuerberater / Datenschutz.

---

## E-invoices (ZUGFeRD / Factur-X)

When you finalise a **Rechnung**, the API produces a PDF/A-3 with embedded EN 16931 Cross Industry Invoice XML (`factur-x.xml`). Tools like lexoffice, sevDesk, and DATEV can read line items and totals from that package.

| Topic | Behaviour |
|-------|-----------|
| Profile target | EN 16931 |
| Kleinunternehmer (§19 UStG) | Tax category `E` |
| Standard USt | Category `S` at your configured rate |
| Numbering | Gapless, per configured series |
| Built-in checks | EN 16931 validator in-app |

> Before you rely on output for tax purposes, validate samples with the official ZUGFeRD tooling / Mustang / veraPDF.

XRechnung-only (pure XML) and full Schematron BR-DE hard-fails are still roadmap items; today some BR-DE checks are warnings.

---

## GoBD — issued documents don’t rewrite history

Finalised (numbered) documents and contracts reject content edits server-side:

- Recipient block, positions, tax posture → **locked**
- Allowed after issue: links to Kunde/Lead, due date, client e-mail, status, payments

UI and API both enforce this. If you need a correction, use **Stornorechnung** (linked draft with negated positions). The original becomes *storniert* only when the Storno is finalised; aggregates net the pair to zero.

---

## DSGVO toolkit

Under **Einstellungen** (admin):

| Tool | Idea |
|------|------|
| Data export | Art. 15 / 20 style dump for a person / record |
| Erasure | Art. 17, with §147 AO retention awareness where books must stay |
| Consent ledger | Track outreach / processing consents |
| Art. 30 record | Processing activities inventory |
| Audit log | Append-only trail of sensitive actions |

Opt-out at send time blocks e-mail even if someone tries to freigeben a draft.

Self-hosting + local AI means customer data does not *have* to leave your infrastructure. You still need your own legal basis, AVVs with processors you *do* use, and a sensible backup policy.

---

## UWG / outreach

SMTP send is gated:

1. Draft only
2. Human freigabe
3. Server appends Impressum + opt-out
4. Then (and only then) the message may leave

There is no bulk “blast everything in the pipeline” switch.

---

## Auth & ops posture

- Passwords: scrypt
- Sessions: server-side in SQLite; logout and password reset revoke them; only token hashes are stored
- CSRF origin checks on mutating requests
- Hardening headers + CSP, request size limits, login/AI rate limits
- Settings / users / backup / DSGVO: admin-gated
- Secrets in Settings: AES-256-GCM under `SETTINGS_KEY`

For production hardening (TLS, proxy trust, backups), see [../deploy/DEPLOY.md](../deploy/DEPLOY.md).

---

## Disclaimer again

OpenLeads is MIT-licensed software, provided as-is. Correct tax treatment, archiving periods, and privacy notices are your responsibility. When in doubt, ask a human who is qualified to answer.
