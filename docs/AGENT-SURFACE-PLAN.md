# Plan: OpenLeads agent / machine surface

**Status 2026-08-10:** Shipped on `main`, and widened.

| Piece | Location | State |
|-------|----------|--------|
| Machine API `/api/machine/*` | `api/src/routes/machine.ts`, `machineAuth.ts` | Shipped |
| CSRF exempt machine + bearer | `csrfExempt` in middleware | Shipped |
| CLI + full stdio MCP | `cli/`, `docs/CLI.md` | Shipped |
| Revocable personal API tokens | Settings + `routes/tokens.ts` | Shipped |
| Isar thin MCP client | `isar-apps/mcp` `crm_*` | Shipped on Isar side |
| **lead_links** (preview URLs on a lead) | `api/src/leadLinks.ts`, drawer, machine + human routes | Shipped 2026-08-10 |
| **Append-only lead notes** | `POST /api/machine/leads/:id/note` | Shipped 2026-08-10 |
| **Read-only finance depth** | contracts, expenses, subscriptions, catalog, payments, EÜR | Shipped 2026-08-10 |

The line the surface draws is **write vs read**, not pipeline vs rest: writes
are leads and customers only; everything else is readable. Nothing on the
machine surface issues, finalises, signs, books or cancels.

**Remaining (product depth, not blockers):**

- Formal tool registry unification (chat tools ↔ domain only).
- Named machine keys with scopes — today `CRM_MACHINE_TOKEN` is one shared
  secret with one principal. Scoped, named, revocable machine keys would let
  the site agent hold a lead-only key while an ops agent reads finance.

**Isar consumer plan:** `../isar-apps/docs/archive/OPENLEADS-MCP-PLAN.md`
