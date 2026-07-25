# CLI & MCP

`openleads` ist die Kommandozeile zu deiner OpenLeads-Instanz — und, mit einem
Unterbefehl, ein **MCP-Server**, den du in einen Agenten-Host einhängen kannst.
Damit wird OpenLeads Teil bestehender Automationen statt eine Insel: „jeden
Morgen um 9 die Pipeline durchgehen, überfällige Rechnungen melden, Sicherung in
die Cloud legen" ist ein Skript oder ein Agenten-Auftrag, kein Klickweg.

Beides spricht dieselbe REST-API wie die Oberfläche, mit demselben Token und
demselben Audit-Trail. Es gibt keinen zweiten Zugangsweg zu den Daten.

---

## Installation

Die CLI liegt im Repo unter `cli/` und hat **keine Laufzeit-Abhängigkeiten** —
nur Node 22.5+.

```bash
cd cli
npm install
npm link          # macht `openleads` global verfügbar
```

Ohne `npm link` geht es genauso über `node cli/dist/main.js …`.

---

## Anmelden

Es gibt bewusst **kein Passwort-Login in der CLI**. Sie hält nur ein API-Token,
das du in der Oberfläche unter **Einstellungen → API-Tokens** erzeugst und dort
jederzeit widerrufen kannst. So bleibt das Kontopasswort aus Shell-History,
Cron-Dateien und Host-Konfigurationen heraus.

> Die Einstellungen sind insgesamt Admins vorbehalten, also auch das Anlegen von
> Tokens. Ein Token handelt anschließend mit den Rechten seines Kontos.

Beim Anlegen wählst du die Reichweite:

| Rechte | Bedeutung |
|--------|-----------|
| **nur lesen** | Abfragen und Exporte. Jede schreibende Anfrage wird serverseitig mit 403 abgewiesen. |
| **lesen & schreiben** | Alles, was dein Konto auch in der Oberfläche darf. |

Das Token wird **genau einmal** angezeigt — der Server speichert nur seinen Hash.

```bash
# Token hinterlegen (prüft ihn, bevor er gespeichert wird)
openleads login --token ol_… --url https://openleads.example.de

# oder ohne Spur in der History:
echo "$OL_TOKEN" | openleads login --token - --url https://openleads.example.de

openleads whoami
```

Gespeichert wird in `~/.openleads/config.json` (Dateirechte `0600`). Mehrere
Instanzen laufen über Profile:

```bash
openleads login --token ol_… --url http://127.0.0.1:8787 --profile lokal
openleads --profile lokal leads list
openleads profiles
```

### Reihenfolge der Quellen

Flag → Umgebungsvariable → Profildatei. Die Umgebung ist der Weg für Cron und
Agenten-Hosts, wo es keine interaktive Anmeldung gibt:

| Variable | Zweck |
|----------|-------|
| `OPENLEADS_URL` | Instanz |
| `OPENLEADS_TOKEN` | API-Token |
| `OPENLEADS_PROFILE` | Profil statt des aktuellen |
| `OPENLEADS_CONFIG` | anderer Pfad für die Profildatei |

---

## Ausgabe

Am Terminal ausgerichtete Spalten, in einer Pipe automatisch JSON. Dasselbe
Kommando funktioniert damit unverändert von Hand und im Skript:

```bash
openleads docs list --overdue                    # Tabelle
openleads docs list --overdue | jq '.[].number'  # JSON, ohne --json
openleads docs list --overdue --json             # JSON erzwingen
```

### Exit-Codes

| Code | Bedeutung |
|------|-----------|
| 0 | in Ordnung |
| 1 | allgemeiner Fehler |
| 2 | Aufruf falsch (fehlendes Argument, fehlendes `--yes`) |
| 3 | nicht authentifiziert / nicht erlaubt (auch: Nur-Lese-Token) |
| 4 | nicht gefunden |
| 5 | Eingabe abgelehnt (Validierung, Konflikt) |
| 6 | Instanz nicht erreichbar |

### Nicht umkehrbare Aktionen

Rechnung ausstellen, Stornorechnung, Vertrag festschreiben, E-Mail versenden,
Sicherung einspielen, Token widerrufen — all das verlangt ausdrücklich `--yes`.
Ohne die Bestätigung passiert nichts und der Exit-Code ist 2.

```bash
openleads docs finalize 42          # verweigert, Code 2
openleads docs finalize 42 --yes    # stellt aus, vergibt die Nummer
```

---

## Befehle

`openleads --help` listet alles, `openleads <gruppe> --help` eine Gruppe,
`openleads <gruppe> <befehl> --help` die Optionen eines Befehls.

### Leads

```bash
openleads leads list --stage neu --limit 20
openleads leads get 42
openleads leads create --website https://beispiel.de --trade Dachdecker --city Kiel
openleads leads move 42 kontaktiert
openleads leads note 42 "Angerufen, Rückruf KW 32"
openleads leads update 42 --priority hoch --assigned-to <benutzername>
openleads leads import kunden.xlsx
openleads leads export --stage angebot -o pipeline.csv
```

### Angebote und Rechnungen

```bash
openleads docs list --kind rechnung --overdue
openleads docs get 7
openleads docs create --kind rechnung --customer 3 \
  --item "Website-Relaunch:1:2500,00" \
  --item "Pflege:12:49,00:Monat"
openleads docs validate 7          # EN 16931 / ZUGFeRD
openleads docs finalize 7 --yes
openleads docs pdf 7 -o ./rechnungen/
openleads docs pay 7 --amount 2975,00 --on 2026-08-01 --method ueberweisung
openleads docs send 7 --yes
openleads docs storno 7 --yes
```

Beträge nimmt die CLI in beiden Schreibweisen: `2500,00` und `2500.00` sind
dasselbe, `1.190` sind eintausendeinhundertneunzig Euro.

### Kunden, Verträge, Ausgaben

```bash
openleads customers list --q "Muster"
openleads customers overview 3
openleads contracts expiring --days 60
openleads contracts finalize 12 --yes
openleads expenses list --from 2026-01-01 --to 2026-03-31
openleads expenses create --gross 23,80 --vendor Hetzner --category hosting
openleads subs list --active
openleads recurring run-due          # nur Entwürfe, nichts wird versendet
```

### Auswertungen und Exporte

```bash
openleads dashboard
openleads digest                     # Morgen-Briefing
openleads report euer --from 2026-01-01 --to 2026-12-31
openleads export datev --from 2026-01-01 -o datev.csv
openleads export invoices | wc -l    # ohne -o auf stdout
```

### Sicherung

```bash
openleads backup -o ./sicherungen/            # Dateiname kommt vom Server
openleads restore sicherung.db --yes          # überschreibt ALLES
```

### Tokens

```bash
openleads tokens list
openleads tokens create --name "Morgen-Briefing" --scope read
openleads tokens revoke 3 --yes
```

`tokens create` gibt ausschließlich das Token auf stdout aus, damit
`TOKEN=$(openleads tokens create --name ci --scope read)` funktioniert.

---

## MCP-Server

`openleads mcp` startet einen MCP-Server über stdio. Der Host startet den
Prozess, nicht du.

### In einen Host eintragen

```json
{
  "mcpServers": {
    "openleads": {
      "command": "openleads",
      "args": ["mcp"],
      "env": {
        "OPENLEADS_URL": "https://openleads.example.de",
        "OPENLEADS_TOKEN": "ol_…"
      }
    }
  }
}
```

Ohne globale Installation:

```json
{ "command": "node", "args": ["/pfad/zu/openleads/cli/dist/main.js", "mcp"] }
```

Neben deinem bestehenden Mail-/Cloud-MCP eingetragen, sieht der Agent beide
Werkzeugsätze und kann sie verbinden: OpenLeads liefert die Zahlen und die
Sicherungsdatei, das andere System verschickt und legt ab.

### Was der Agent darf

Voreingestellt: **lesen, plus Schreibvorgänge, die ein Mensch rückgängig machen
kann.**

| Tier | Werkzeuge |
|------|-----------|
| lesen | `list_leads`, `get_lead`, `pipeline_overview`, `morning_digest`, `list_invoices`, `get_invoice`, `list_customers`, `customer_overview`, `list_contracts`, `list_expenses`, `list_subscriptions`, `list_recurring`, `list_catalog`, `euer_report`, `export_csv`, `create_backup` |
| umkehrbar schreiben | `create_lead`, `update_lead`, `add_lead_note`, `analyze_lead`, `draft_outreach`, `create_customer`, `create_invoice_draft`, `create_expense`, `run_due_recurring` |
| **nicht umkehrbar** (aus) | `finalize_invoice`, `send_invoice`, `create_storno`, `finalize_contract`, `send_contract`, `ask_copilot` |

Das dritte Tier ist nicht registriert, solange du es nicht freischaltest — ein
Agent kann es also nicht einmal versehentlich aufrufen:

```bash
openleads mcp --allow-irreversible          # oder OPENLEADS_MCP_ALLOW_IRREVERSIBLE=1
openleads mcp --read-only                   # nur das Lese-Tier
openleads mcp --max-rows 25                 # Listen kürzen (Standard 50)
```

`ask_copilot` steckt im dritten Tier, weil der eingebaute Copilot seinerseits
schreibende Werkzeuge hat — inklusive Ausstellen und Festschreiben.

Zwei Absicherungen greifen unabhängig voneinander: das Tier bestimmt, welche
Werkzeuge der Host überhaupt sieht; die Reichweite des Tokens bestimmt, was der
Server durchlässt. Ein Nur-Lese-Token mit `--allow-irreversible` bleibt
harmlos — jeder Schreibversuch endet in einem 403.

### Beträge und Daten

Alle Beträge in **Cent** (`gross_cents`, `unit_price_cents`), alle Daten als
`YYYY-MM-DD`. Listen sind auf `--max-rows` gekappt; wird gekürzt, steht das im
Ergebnis, statt still abzuschneiden.

---

## Beispiel: die 9-Uhr-Routine

Als Skript, mit einem **Nur-Lese-Token** für alles außer der Sicherung:

```bash
#!/usr/bin/env bash
set -euo pipefail
export OPENLEADS_URL="https://openleads.example.de"
export OPENLEADS_TOKEN="$(cat ~/.config/openleads.token)"

heute=$(date +%F)
ziel=~/berichte/"$heute"
mkdir -p "$ziel"

openleads digest                     > "$ziel/briefing.txt"
openleads leads list --stage neu     --json > "$ziel/neue-leads.json"
openleads docs list --overdue        --json > "$ziel/ueberfaellig.json"
openleads contracts expiring --days 60 --json > "$ziel/auslaufend.json"
openleads backup -o "$ziel/"

# ab hier übernimmt das Werkzeug, das Cloud und Mail kann
```

Als Agenten-Auftrag mit beiden MCP-Servern im selben Host — statt fester
Reihenfolge beschreibst du das Ziel:

> Ruf jeden Werktag um 9 Uhr `morning_digest` und `pipeline_overview` von
> OpenLeads ab, hol überfällige Rechnungen mit `list_invoices(only_overdue)` und
> in 60 Tagen auslaufende Verträge mit `list_contracts(expiring_within_days: 60)`.
> Fasse das in einer Mail an mich zusammen. Leg außerdem mit `create_backup` eine
> Sicherung an und lade sie in die Cloud.

Nichts davon verlässt das Lese-Tier — der Agent kann diese Routine nicht
ausweiten, egal was in einer Mail steht, die er dabei liest.

### Als Cron

```cron
0 9 * * 1-5  /usr/local/bin/morgenroutine.sh >> /var/log/openleads-cron.log 2>&1
```

---

## Fehlersuche

| Symptom | Ursache |
|---------|---------|
| `Nicht authentifiziert — Token fehlt oder ist ungültig.` | Token widerrufen, abgelaufen oder zur falschen Instanz |
| `Dieses API-Token darf nur lesen.` | Nur-Lese-Token für einen Schreibvorgang |
| `Nur für Administratoren.` | `backup`/`restore`/`settings` brauchen ein Admin-Konto |
| `… nicht erreichbar (fetch failed)` | falsche URL, Instanz aus, Firewall |
| Host zeigt den Server als verbunden, aber ohne Werkzeuge | Serverstart auf stderr prüfen — ohne Token bricht er sofort ab |

Der MCP-Server schreibt seinen Status beim Start nach stderr; die Hosts zeigen
das in ihren Logs.

---

## Siehe auch

- [MODULES.md](MODULES.md) — was die Module in der Oberfläche können
- [AI.md](AI.md) — Copilot und seine Werkzeuge
- [COMPLIANCE.md](COMPLIANCE.md) — warum Ausstellen und Storno Einbahnstraßen sind
