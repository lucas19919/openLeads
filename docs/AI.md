# OpenLeads AI core

AI is not a feature of OpenLeads — it is the spine. The same data the UI shows is
also a set of **tools the model can operate**: it finds, reads, qualifies, and
updates leads, drafts compliant outreach, and turns a sentence into an invoice.

## Design principles

1. **Open source, self-hostable, on-prem first.** The default target is a local
   [Ollama](https://ollama.com) — open weights, no cloud account, no data egress.
   This is both a DSGVO posture (personal data never leaves the operator's box)
   and the point of the project: a pilot for **German/EU AI in sales**.
2. **One protocol, any model.** Everything goes through the OpenAI-compatible
   `/chat/completions` API (`src/ai/provider.ts`). That means Ollama, vLLM,
   llama.cpp, LM Studio, Mistral, and EU-hosted inference all work unchanged —
   swap `AI_BASE_URL` / `AI_MODEL`.
3. **Human-in-the-loop.** The AI drafts and recommends; it never sends mail or
   finalises an invoice on its own. UWG §7 and trust both demand a human gate.
4. **Auditable.** Every AI action writes to the `audit_log` (DSGVO Art. 5(2)).

## Configuration

See `api/.env.example`. The essentials:

```
AI_BASE_URL=http://localhost:11434/v1   # local Ollama by default
AI_MODEL=llama3.1:8b
AI_API_KEY=                              # only for hosted endpoints
```

German-capable open models worth trying: `llama3.1:8b`, `qwen2.5:7b-instruct`,
`mistral-small` (Ollama); `Teuken-7B`, `EuroLLM-9B` (EU projects, via vLLM).

## Surface

| Endpoint | What it does |
|----------|--------------|
| `GET  /api/ai/status` | model reachable? inference local? |
| `POST /api/ai/chat` | **Copilot** — agent loop with tools, persisted threads |
| `POST /api/ai/leads/:id/analyze` | qualify a lead (summary, fit, next action) |
| `POST /api/ai/leads/:id/outreach` | draft a first-touch message (never sent) |
| `GET  /api/ai/leads/:id/outreach` | list drafts |
| `PATCH /api/ai/outreach/:id` | approve / edit / mark sent / discard |
| `POST /api/ai/invoice/draft` | natural language → structured document draft |

### Copilot tools (`src/ai/tools.ts`)

`search_leads`, `get_lead`, `update_lead`, `move_lead_stage`, `add_note`,
`analyze_lead`, `draft_outreach`, `pipeline_stats`, `list_documents`,
`create_document`, `get_settings`. Each is a small, audited capability over the
same database the UI uses.

## Layout

```
api/src/ai/
  provider.ts   OpenAI-compatible client (fetch, no SDK) + JSON helpers + probe
  types.ts      chat/tool message types
  prompts.ts    German system prompts + compliance guardrails (one place)
  tools.ts      the agent's hands — domain tools with JSON schemas
  agent.ts      the copilot loop (call → run tools → feed back → answer)
  leadIntel.ts  analyze lead · draft outreach · NL→invoice
  router.ts     Hono routes
```

No new runtime dependencies: the whole core is `fetch` + Node built-ins.
