# Usage

Day-to-day patterns once OpenLeads is running. For module screenshots see [MODULES.md](MODULES.md).

---

## A typical flow

1. **Lead comes in** — import a sheet, type one manually, or ask Chat to read a website URL.
2. **Qualify** — set stage, priority, notes; optional AI fit score and talking points.
3. **Outreach** — draft in Chat or on the lead; freigeben, then send (SMTP). Impressum + opt-out are appended automatically.
4. **Kunde** — when they convert, create or link a customer so invoices and contracts share one registry.
5. **Angebot** — pick from the Leistungskatalog or describe the job in one sentence for a draft.
6. **Vertrag** (optional) — finalise to freeze AGB and get a PDF; or **PDF ablegen** for an external contract.
7. **Rechnung** — convert / create, Festschreiben → ZUGFeRD PDF. Record payments as they land.
8. **Serie** — for Hosting/Wartung, attach a Serienrechnung so each period drops a draft Rechnung for review.

---

## Navigation & search

- **Strg/Cmd+K** (or *Suche* in the sidebar) — jump palette over Kunden, Belege, Verträge, Serien, Leads.
- Cross-module links leave a **← Zurück zu …** bar. Browser / hardware back uses the same stack.
- Clicking an already-active sidebar tab closes open editors and returns to the module list.

---

## Importing leads

Use **Import xlsx** on the Leads screen, or the CLI:

```bash
cd api
npm run import -- /path/to/leads.xlsx
```

Headers are auto-detected (German or English). Useful columns:

| Header examples | Field |
|-----------------|-------|
| Firma, Company | company |
| Gewerk, Branche | trade |
| Ort, Stadt, City | city |
| Website, URL | website |
| Telefon, Tel | phone |
| E-Mail, Mail | email |
| Prio | priority (`hoch` / `mittel` / `niedrig`) |
| Score | score |
| Technik, CMS | tech |
| Mobil | mobile_friendly (`ja` / `nein`) |
| Signal | staleness_signal |
| Warum Lead | why_lead |

Ready-made sample files: **[templates/](templates/)**.

Dedupe key is the **domain** of the website. Same domain twice → update path, not a second lead.

---

## Invoices worth knowing

- **Festschreiben** assigns the next number and locks content. Metadata like due date, client e-mail, payment status can still change.
- **Stornieren** on a finalised Rechnung creates a correction draft (negated positions + §14 reference). The original becomes *storniert* only when you finalise the Storno. Dashboard and EÜR treat the pair as **zero**.
- Partial payments are fine; full settlement marks the invoice *bezahlt*.
- Kleinunternehmer (§19 UStG) is a company-level posture — it shows up on the PDF and in the Factur-X tax category.

---

## Contracts worth knowing

- Finalise freezes the **AGB text as it was that day** onto the contract record.
- External paper? **PDF ablegen** — no builder, no number, still appears in Fristende reminders if you set an end date.
- Link a Serie from the contract editor for recurring Hosting billing.

---

## Backup

From the UI (admin): **Einstellungen → Backup herunterladen (.db)** — a consistent SQLite snapshot (`VACUUM INTO`), not a raw file copy that might miss WAL.

CLI (dev or container):

```bash
cd api
npm run backup
npm run restore -- /path/to/backup.db
```

Prefer these over `cp leads.db`. Details for production volumes: [../deploy/DEPLOY.md](../deploy/DEPLOY.md).

---

## Roles

| Role | Can |
|------|-----|
| `admin` | Everything, including Firma, Einstellungen, users, backup, DSGVO tools |
| `member` | Day-to-day work on leads, customers, documents, contracts, expenses |

There is no per-row ACL yet — members see the same data, just not the admin tabs.
