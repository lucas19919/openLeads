# Build progress — autonomous AI-core session

Working log so the build can resume cleanly across turns. Target: the ultimate
AI-native German leads + Rechnungen tool. Branch: `claude/openleads-repo-setup-zphxio`.

## Done & verified (pushed)
- **AI core** (`api/src/ai/*`): OpenAI-compatible provider (open-source/local
  first), copilot agent loop, domain tools, lead intelligence (analyze/outreach),
  NL→invoice. Agent loop tested against a mock model (tool call → DB → answer). ✅
- **DSGVO toolkit** (`api/src/dsgvo.ts`, `audit.ts`): audit log, export, erasure
  (with §147 AO retention), consent ledger, Art. 30 record. ✅
- **EN 16931 validator** (`api/src/validate.ts`) + endpoint; unit-verified. ✅
- **Backups** (`api/src/backup.ts`, `scripts/backup.ts`, `npm run backup`). ✅
- **Web**: KI-Cockpit chat, AI status badge, per-lead AI panel (qualify/outreach/
  DSGVO), validate/backup client. tsc + build clean. ✅
- Docs: ROADMAP, docs/AI.md, docs/COMPLIANCE.md, README repositioned. ✅

## Verification commands
- API: `cd api && npx tsc --noEmit`
- Web: `cd web && npx tsc --noEmit && npm run build`

## Also done & verified (pushed)
- **Document editor UI**: EN 16931 validator panel, NL→invoice box, Settings
  backup download. ✅
- **Dunning (Mahnwesen)**: overdue detection, Mahnstufen, §288 BGB Verzugszinsen
  + €40 Pauschale; endpoints + table + client. Interest math unit-verified. ✅

## Also done & verified (pushed)
- **Mahnwesen UI** ("Offene Posten" tab): overdue worklist + one-click Mahnung. ✅
- **AI daily digest** (`/api/ai/digest`) + KI-Cockpit "Tages-Briefing". ✅
- **Tests + CI**: 16 Node-test unit tests (totals, validator, dunning, Factur-X);
  CI runs `npm test` for api. ✅

## Also done & verified (pushed)
- **Semantic lead search** (`/api/ai/leads/search`, local embeddings + cosine,
  SQL fallback offline). Verified ranking against a mock embedder. ✅
- **Gated SMTP send** (`/api/ai/outreach/:id/send`): only status=freigegeben,
  Impressum + opt-out auto-appended, audited. 5 composition tests. ✅

## Next queue (in priority order)
1. **Mahnung PDF** (reuse pdfkit) + endpoint.
2. **XRechnung / BR-DE** validation specifics (warnings) + profile note.
3. **UI polish**: outreach "Senden" button (LeadDetail), semantic "KI-Suche" box
   (LeadsView), reindex trigger.
4. Smoke-test full HTTP boot (login → create → finalize → validate → backup).

## Conventions
Dependency-light (Node built-ins + fetch). German UI. Strict TS. Money in cents.
AI never auto-sends. Every personal-data write + AI action → `audit()`.
