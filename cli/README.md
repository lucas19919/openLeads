# @openleads/cli

Kommandozeile und MCP-Server für den [Isar Kunden Manager](../README.md).

```bash
npm install && npm link

openleads login --token ol_… --url https://openleads.example.de
openleads leads list --stage neu
openleads docs list --overdue --json
openleads backup -o ./sicherungen/
openleads mcp        # MCP-Server über stdio, für Agenten-Hosts
```

Keine Laufzeit-Abhängigkeiten, Node 22.5+. Spricht dieselbe REST-API wie die
Oberfläche, mit einem API-Token aus **Einstellungen → API-Tokens**.

Vollständige Anleitung: [docs/CLI.md](../docs/CLI.md).
