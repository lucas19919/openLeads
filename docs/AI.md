# AI copilot

The Chat module is not a sidekick with a private brain — it drives OpenLeads through the **same tools** the UI uses, with the same audit trail.

---

## Defaults

| Setting | Default |
|---------|---------|
| Protocol | OpenAI-compatible Chat Completions |
| Endpoint | `http://localhost:11434/v1` (local Ollama) |
| Model | `llama3.1:8b` |

Wire-up: [SETUP.md](SETUP.md) §3, or **Einstellungen → KI-Anbindung**.

Any OpenAI-compatible stack works (Ollama, vLLM, hosted EU providers). Prefer local when DSGVO is the priority — inference stays on your hardware.

---

## What it can do

Rough map of the tool surface (prompts are tuned for a German web agency):

- **Leads** — list, create, update stages/priority, qualify, score, draft outreach
- **From URL** — read a public website *and its Impressum*, record what it said, create a qualified lead
- **Recherche** — `research_company` (look, save nothing), `research_lead` (re-check an existing lead)
- **Belege** — `record_fact` / `list_facts`: every machine-written value carries its source
- **Kunden** — find / create registry entries
- **Documents** — draft Angebote/Rechnungen from natural language, attach catalog lines
- **Catalog** — list / add Leistungskatalog items
- **Contracts** — draft and finalise (with the usual human checks in the UI)

The voice is German by default: Website-Pakete, Relaunch, Hosting & Pflege, SEO, Google Business Profil.

---

## Hard limits (on purpose)

1. **Nothing leaves without approval.** Outreach e-mail is drafted and marked for freigabe. SMTP only sends after a human confirms. Impressum + opt-out footer are appended server-side.
2. **No silent side channels.** Tools go through the API layer; actions show up in the audit log with actor and (where relevant) IP.
3. **You can run without AI.** If the endpoint is down, the badge shows *KI offline* and Chat is inert. CRM and billing keep working.
4. **It may not overwrite you.** Anything the AI writes into a lead is graded first: only a value the business states about *itself* (Impressum, signature, its own reply) fills an empty field outright. Everything weaker — and everything that disagrees with a value you set by hand — becomes a suggestion you accept or reject. The priority you set by dragging a card is never revised by a re-analysis.

---

## Where a value came from

Every machine-written field is backed by a row in the evidence ledger: the claim, what the source literally said, the URL, and the grading. `list_facts` (chat), `list_lead_facts` / `review_facts` (MCP) and `GET /api/leads/:id/facts` all read it.

Grades:

| Beleg | Was das heißt | Folge |
|-------|---------------|-------|
| `primary` | Der Betrieb sagt es über sich selbst — Impressum, Signatur, eigene Antwort | füllt ein leeres Feld sofort |
| `supporting` | Mittelbar: Suchtreffer, Erwähnung Dritter, `og:site_name` | Vorschlag zur Prüfung |
| `contradiction` | Die Quelle widerspricht dem gespeicherten Wert | Feld bleibt, Widerspruch wird vermerkt |

The German Impressum does the heavy lifting here: §5 DDG obliges every business site to publish Firma, Rechtsform, Anschrift, Geschäftsführung, Handelsregister and USt-IdNr., which makes it a free primary source no amount of model guessing can match. Fields the leads table has no column for (USt-IdNr., Handelsregister, Rechtsform, Inhaber) are kept in the ledger and are there when the lead becomes a Kunde.

---

## Tips

- Be concrete: “Angebot an *Kunde X*, Positionen aus Katalog Website Business + Hosting 12 Monate” beats “mach mal eine Rechnung”.
- Review drafts before Festschreiben — the model can mis-hear amounts; numbers are net cents under the hood.
- For lead gen from the web, give a full `https://…` URL and a short note about what you sell.
- If answers feel off-domain, check `AI_MODEL` / temperature under Einstellungen; lower temperature (default `0.3`) keeps it more tool-ish than chatty.

---

## Security notes

- API keys saved in the UI are encrypted at rest with `SETTINGS_KEY` (AES-256-GCM). The key never lives in the database.
- Rate limits apply to login and AI routes.
- Don’t point a public OpenLeads instance at a shared cloud model with live customer PII unless that fits your own processing agreement — local Ollama is the intended default for a reason.
