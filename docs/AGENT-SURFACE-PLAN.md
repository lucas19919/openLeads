# Plan: Kunden Manager agent / machine surface

**Status 2026-08-10:** Shipped on `main`, and widened — twice.

| Piece | Location | State |
|-------|----------|--------|
| Machine API `/api/machine/*` | `api/src/routes/machine.ts`, `machineAuth.ts` | Shipped |
| CSRF exempt machine + bearer | `csrfExempt` in middleware | Shipped |
| CLI + full stdio MCP | `cli/`, `docs/CLI.md` | Shipped |
| Revocable personal API tokens | Settings + `routes/tokens.ts` | Shipped |
| **lead_links** (preview URLs on a lead) | `api/src/leadLinks.ts`, drawer, machine + human routes | Shipped 2026-08-10 |
| **Append-only lead notes** | `POST /api/machine/leads/:id/note` | Shipped 2026-08-10 |
| **Read-only finance depth** | contracts, expenses, subscriptions, catalog, payments, EÜR | Shipped 2026-08-10 |
| **Invoice authoring (drafts)** | `createDraftDocument`/`patchDocument`/… in `documents.ts`, machine + copilot + MCP | Shipped 2026-08-10 |
| **Freigaben (human approvals)** | `api/src/approvals.ts`, `routes/approvals.ts`, `ApprovalsPanel.tsx` | Shipped 2026-08-10 |

## The line the surface draws

It is **not** "pipeline vs finance" any more, and never really was. It is
**reversible vs not**:

- **Reversible → the agent's own.** Leads, customers, notes, links, and now the
  whole drafting half of invoicing: create an Angebot or a Rechnung, edit it,
  price it, convert an accepted quote, prepare a Storno, delete a draft. No
  number is consumed, nothing has left the building, one click undoes any of it.
- **Irreversible → a human decides, per document.** Festschreiben (a gapless
  number is spent and the content freezes — §14 UStG / GoBD) and Versenden (the
  PDF is in a client's inbox) require a Freigabe granted from an interactive
  login, bound to a fingerprint of the exact content shown, single-use and
  time-boxed (`CRM_APPROVAL_TTL_MINUTES`, default 24 h).
- **Still human-only, no Freigabe path.** Booking payments, writing or signing
  contracts, deleting anything issued, settings, and every binary (signed PDFs,
  receipt scans).

The rule holds across all three agent entry points, because they all pass the
same gate:

| Caller | Credential | Festschreiben / Versenden |
|--------|-----------|---------------------------|
| Browser (a person) | session cookie / SSO proxy | allowed — the click *is* the approval |
| CLI, MCP server, cron | personal API token | needs `approval_id` |
| Suite agents | `CRM_MACHINE_TOKEN` | needs `approval_id` |
| Built-in copilot | runs as the logged-in user | no finalise tool at all; `request_approval` only |

Deciding is session-only: a token can raise a Freigabe and watch it, never grant
it. Without that asymmetry an agent holding a write token would simply approve
its own request.

**Remaining (product depth, not blockers):**

- Formal tool registry unification (chat tools ↔ domain only).
- Named machine keys with scopes — today `CRM_MACHINE_TOKEN` is one shared
  secret with one principal. Scoped, named, revocable machine keys would let
  the site agent hold a lead-only key while an ops agent reads finance.
- Notifying a human that a Freigabe is waiting (today it surfaces on the
  dashboard when they next look; mail/push would close the loop).
- Contract authoring on the machine surface. The Freigabe mechanism already
  covers `contract.finalize` / `contract.send` for token callers; the machine
  surface itself still has no way to *write* a contract, so it cannot request
  those either.

