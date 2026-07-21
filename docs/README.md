# OpenLeads documentation

Guides for running and using OpenLeads. The product UI is German (DACH market); these docs are written in English so contributors and operators share one reference. Screenshots show the real app.

---

## Start here

| Guide | For |
|-------|-----|
| [../README.md](../README.md) | Product overview + quick start |
| [SETUP.md](SETUP.md) | Local development, env vars, Ollama |
| [MODULES.md](MODULES.md) | What each sidebar tab does (screenshots) |
| [USAGE.md](USAGE.md) | Daily workflow: leads → Angebot → Rechnung |
| [AI.md](AI.md) | Copilot behaviour and limits |
| [COMPLIANCE.md](COMPLIANCE.md) | E-invoices, immutability, DSGVO toolkit |
| [templates/](templates/) | Ready-made import files |
| [../deploy/DEPLOY.md](../deploy/DEPLOY.md) | Production (Docker + nginx) |

---

## Screenshots

Captured from a running instance. To refresh them:

```bash
# API on :8787, web on :5173, then:
node docs/scripts/capture-screenshots.mjs
```

Set `OPENLEADS_URL`, `OPENLEADS_USER`, and `OPENLEADS_PASS` if your setup differs from the script defaults.

---

## Contributing notes

- User-facing product text stays German.
- Domain logic lives in `api/src/<domain>.ts`; HTTP in `api/src/routes/`.
- Design tokens: `web/src/tokens.css` (“Kanzlei” theme). Don’t invent raw hex in components.
- Keep docs short and human — prefer one clear paragraph over a wall of bullet points.
