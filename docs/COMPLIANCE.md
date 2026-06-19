# Compliance notes (DSGVO / UWG / e-invoicing)

> Not legal advice. OpenLeads is built to make lawful operation the easy path,
> but the operator is the controller and is responsible for their own use.

## DSGVO (GDPR)

OpenLeads is **self-hosted**: personal data stays on infrastructure the operator
controls. With the default local AI, even inference data never leaves the box.

Implemented support:

- **Art. 5(2) accountability** — every write touching personal data and every AI
  action is appended to `audit_log`. See `GET /api/dsgvo/audit`.
- **Art. 15 / 20 access & portability** — `GET /api/dsgvo/lead/:id/export`
  returns everything held about a lead as JSON.
- **Art. 17 erasure** — `POST /api/dsgvo/lead/:id/erase`. Cascades remove events,
  AI analysis, outreach and consent. Numbered invoices are **legally retained**
  (§147 AO, §14b UStG = 10 years), so they are *detached* from the personal
  record (lead link nulled) rather than destroyed, and the erasure is logged.
- **Art. 21 objection / opt-out** — consent ledger (`consent` table) records the
  lawful basis per lead and channel; entries can be withdrawn.
- **Art. 30 record of processing** — `GET /api/dsgvo/processing` returns a living
  Verzeichnis, including whether AI inference is local or via a processor.

### Lawful basis for B2B prospecting

Cold B2B prospecting typically rests on **Art. 6(1)(f)** (legitimate interest).
Record it per lead in the consent ledger; honour objections immediately.

## UWG §7 — unsolicited advertising

This is the sharp edge in Germany and the AI is prompted to respect it:

- **E-mail advertising** generally requires prior consent (§7 Abs. 2 Nr. 2).
- **B2B telephone advertising** needs at least *mutmaßliche Einwilligung*.
- Drafted outreach always includes sender identification and a one-line opt-out,
  and the AI refuses to invent facts about the recipient.

The product **never auto-sends**. A human reviews and approves every message.

## E-invoicing (ZUGFeRD / Factur-X / XRechnung)

Finalised invoices are hybrid **PDF/A-3 with embedded EN 16931 CII XML**
(`src/facturx.ts`), Kleinunternehmer **§19 UStG** aware, with gapless numbering.

Since 2025 German domestic B2B must be able to **receive** structured e-invoices
(Wachstumschancengesetz); OpenLeads issues them by default. Roadmap: XRechnung
profile for B2G and a built-in EN 16931 schema/Schematron validator.
