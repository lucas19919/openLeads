# OpenLeads roadmap — the AI-native German sales & invoicing tool

Goal: the best self-hostable tool for **Leads → Ansprache → Angebot → Rechnung**
in the DACH market, where **AI is the core**, the stack is **open source**, and
**DSGVO/UWG** compliance is built in rather than bolted on.

## Positioning vs. existing tools

| Tool | Gap OpenLeads closes |
|------|----------------------|
| Pipedrive / HubSpot CRM | Not self-hostable; data leaves the EU; AI is an upsell add-on; no German invoicing. |
| sevDesk / lexoffice (invoicing) | No lead gen / CRM; closed SaaS; AI minimal. |
| Apollo / Cognism (lead gen) | US-centric, expensive, DSGVO-grey, no invoicing, no on-prem. |
| **OpenLeads** | One self-hosted suite, lead→invoice joined up, **AI operates the whole flow**, open weights, data stays on-prem. |

## Status

### ✅ Done (baseline)
- Lead scraper (Claude web search), staleness scoring, CRM pipeline, xlsx import.
- Angebote/Rechnungen, gapless numbering, ZUGFeRD/Factur-X PDF/A-3, §19 UStG.

### ✅ Done (AI-core release — this branch)
- **Model-agnostic AI provider** (OpenAI-compatible, open-source/local first).
- **Copilot agent** that operates the CRM + invoicing via audited tools.
- **Lead intelligence**: AI qualification, fit scoring, next-best-action.
- **Outreach drafting** (DSGVO/UWG-aware, human-approved, never auto-sent).
- **Natural-language invoicing** (text → structured draft).
- **DSGVO toolkit**: audit log, data export, erasure (with §147 AO retention),
  consent ledger, Art. 30 processing record.

### 🔜 Next
- [ ] **Frontend AI cockpit**: copilot command bar + per-lead "Analyse/Entwurf".
- [ ] **Outreach editor** UI with approve/send + opt-out tracking.
- [ ] **NL→invoice** UI in the document editor.
- [ ] **Embeddings / semantic lead search** (local embedding model).
- [ ] **EN 16931 validator** (Schematron) + **XRechnung** profile for B2G.
- [ ] **Email send** integration (SMTP) gated behind explicit approval + opt-out.
- [ ] **Automated follow-up** suggestions from pipeline state + recontact dates.
- [ ] **Backups**: scheduled SQLite snapshot + restore (operator data ownership).
- [ ] **Dunning** (Mahnwesen) with legal-rate Verzugszinsen.
- [ ] **GoBD**-conform export (DATEV/CSV) for the Steuerberater.

## Principles
1. AI is the spine, not a plugin. 2. Open weights, self-hostable, on-prem first.
3. Human-in-the-loop for anything outward-facing. 4. Compliance by construction.
5. Dependency-light (Node built-ins + fetch).
