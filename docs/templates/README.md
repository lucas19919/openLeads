# Templates

Ready-made files you can open, edit, and import. Sample rows are fake — replace them with your prospects.

---

## Lead import

| File | Format |
|------|--------|
| [leads-import.xlsx](leads-import.xlsx) | Excel (best with the in-app **Import xlsx** button) |
| [leads-import.csv](leads-import.csv) | CSV fallback — open in LibreOffice/Excel and save as `.xlsx` if the uploader expects a workbook |

### Columns

| Column | Notes |
|--------|--------|
| **Firma** | Required in practice — the name on the card |
| Gewerk | Trade / industry |
| Ort | City |
| Website | Used for **domain dedupe** |
| Telefon / E-Mail | Contact |
| Prio | `hoch`, `mittel`, or `niedrig` |
| Score | Number |
| Technik | e.g. WordPress, Wix |
| Mobil | `ja` / `nein` |
| Signal | Why the site looks stale (“Impressum 2019”) |
| Warum Lead | Your pitch note |

Headers can be German or English; the parser picks the row that maps the most columns (banner rows above the table are fine).

### Import

**UI:** Leads → **Import xlsx**

**CLI** (writes straight into the DB; no running server needed for the import itself, but use the same `DB_PATH`):

```bash
cd api
npm run import -- ../docs/templates/leads-import.xlsx
```

---

## Document / contract “templates”

OpenLeads does not ship separate Word templates for invoices and contracts — those are generated as PDFs from your **Firma** profile, **Leistungskatalog**, and (for contracts) the AGB text under Einstellungen.

What *is* pre-seeded on a fresh database:

- Website Starter / Business / Premium packages  
- Relaunch  
- Hosting & Domain, Website-Pflege  
- SEO and related local-marketing items  

Edit prices and names under **Einstellungen → Leistungskatalog**. Lines are copied by value onto each Beleg, so catalog edits never rewrite old invoices.

For recurring Hosting, create a **Serienrechnung** on the Vertrag or Kunde rather than duplicating drafts by hand.

---

## Regenerating screenshots

Not a content template, but operators documenting forks often want fresh images:

```bash
# with api + web running and a login available
OPENLEADS_USER=… OPENLEADS_PASS=… node docs/scripts/capture-screenshots.mjs
```

Script: [../scripts/capture-screenshots.mjs](../scripts/capture-screenshots.mjs). Output lands in `docs/images/`.
