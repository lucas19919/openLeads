import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { euro, centsToInput, inputToCents } from '../../money'
import { fmtDate, todayISO } from '../../util'
import type { Config, Contract } from '../../types'

const CLIENT_TYPE_LABEL: Record<string, string> = { geschaeft: 'Geschäft (B2B)', privat: 'Privat (B2C)' }
const STATUS_LABEL: Record<string, string> = {
  entwurf: 'Entwurf',
  versendet: 'Versendet',
  aktiv: 'Aktiv',
  beendet: 'Beendet',
  abgelehnt: 'Abgelehnt',
}

type Draft = Partial<Contract>

function blankDraft(config: Config): Draft {
  return {
    type: config.contractTypes[0]?.id ?? 'dienstvertrag',
    client_name: '',
    client_type: config.clientTypes[0] ?? 'geschaeft',
    title: config.contractTypes[0]?.label ?? 'Vertrag',
    intro: '',
    body: '',
    value_cents: 0,
    small_business: 1,
    vat_rate: 19,
    payment_terms: '',
    start_date: '',
    end_date: '',
    notice_period: '',
    notes: '',
  }
}

export function ContractsView({ config }: { config: Config }) {
  const [rows, setRows] = useState<Contract[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const typeLabel = (id: string) => config.contractTypes.find((t) => t.id === id)?.label ?? id

  const refresh = useCallback(async () => {
    const { contracts } = await api.listContracts()
    setRows(contracts)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  function flash(m: string) {
    setMsg(m)
    setError(null)
  }
  function fail(e: unknown) {
    setError(e instanceof Error ? e.message : 'Aktion fehlgeschlagen.')
  }

  async function remove(id: number) {
    if (!confirm('Vertragsentwurf löschen?')) return
    try {
      await api.deleteContract(id)
      await refresh()
    } catch (e) {
      fail(e)
    }
  }

  async function saveDraft() {
    if (!draft) return
    setBusy(true)
    setError(null)
    try {
      const body: Partial<Contract> = {
        type: draft.type,
        client_name: draft.client_name,
        client_address: draft.client_address,
        client_zip: draft.client_zip,
        client_city: draft.client_city,
        client_email: draft.client_email,
        client_type: draft.client_type,
        title: draft.title,
        intro: draft.intro,
        body: draft.body,
        value_cents: draft.value_cents,
        small_business: draft.small_business,
        vat_rate: draft.vat_rate,
        payment_terms: draft.payment_terms,
        start_date: draft.start_date || null,
        end_date: draft.end_date || null,
        notice_period: draft.notice_period,
        notes: draft.notes,
      }
      const { contract } = draft.id
        ? await api.updateContract(draft.id, body)
        : await api.createContract(body)
      setDraft(contract)
      await refresh()
      flash('Gespeichert.')
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  async function finalize() {
    if (!draft?.id) return
    if (!confirm('Vertrag festschreiben? Es wird eine Vertragsnummer vergeben und die aktuellen AGB werden eingefroren.')) return
    setBusy(true)
    try {
      const { contract } = await api.finalizeContract(draft.id)
      setDraft(contract)
      await refresh()
      flash(`Festgeschrieben als ${contract.number}.`)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  async function sign() {
    if (!draft?.id) return
    const by = prompt('Name der unterzeichnenden Person (Auftraggeber):', draft.client_name ?? '')
    if (by === null) return
    setBusy(true)
    try {
      const { contract } = await api.signContract(draft.id, { signed_by: by, signed_at: todayISO() })
      setDraft(contract)
      await refresh()
      flash('Als unterzeichnet markiert — Vertrag ist aktiv.')
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  async function send() {
    if (!draft?.id) return
    setBusy(true)
    try {
      const r = await api.sendContract(draft.id)
      flash(`Versendet an ${r.to}.`)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  async function uploadSigned(file: File) {
    if (!draft?.id) return
    setBusy(true)
    setError(null)
    try {
      const { contract } = await api.uploadSignedContract(draft.id, file)
      setDraft(contract)
      await refresh()
      flash('Unterschriebenes Dokument gespeichert.')
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  async function removeSigned() {
    if (!draft?.id) return
    if (!confirm('Unterschriebenes Dokument entfernen?')) return
    setBusy(true)
    try {
      const { contract } = await api.deleteSignedContract(draft.id)
      setDraft(contract)
      await refresh()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(false)
    }
  }

  async function changeStatus(status: string) {
    if (!draft?.id) return
    try {
      const { contract } = await api.updateContract(draft.id, { status })
      setDraft(contract)
      await refresh()
    } catch (e) {
      fail(e)
    }
  }

  // --- editor ---
  if (draft) {
    const d = draft
    const setD = (patch: Partial<Draft>) => setDraft((cur) => (cur ? { ...cur, ...patch } : cur))
    const locked = !!d.number // finalised: content is frozen (number issued, AGB snapshotted)
    const net = d.value_cents ?? 0
    const gross = d.small_business ? net : net + Math.round((net * (d.vat_rate ?? 19)) / 100)
    return (
      <div className="content">
        <div className="doc-editor">
          <div className="doc-editor-head">
            <button className="ghost" onClick={() => { setDraft(null); setMsg(null); setError(null) }}>Zurück</button>
            <strong>{d.id ? (d.number ?? 'Vertragsentwurf') : 'Neuer Vertrag'}</strong>
            {d.status && <span className={`doc-status doc-status-${d.status}`}>{STATUS_LABEL[d.status] ?? d.status}</span>}
            <div className="spacer" />
            {error && <span className="user-chip" style={{ color: 'var(--danger)' }}>{error}</span>}
            {msg && <span className="user-chip">{msg}</span>}
            {!locked && (
              <button className="primary" onClick={saveDraft} disabled={busy}>
                {busy ? '…' : 'Speichern'}
              </button>
            )}
            {d.id && (
              <a className="ghost" href={api.contractPdfUrl(d.id)} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
                <button className="ghost">PDF</button>
              </a>
            )}
            {d.id && !d.number && (
              <button onClick={finalize} disabled={busy}>Festschreiben</button>
            )}
            {d.number && (
              <button onClick={send} disabled={busy || !d.client_email} title={d.client_email ? 'Vertrag als PDF per E-Mail senden' : 'Keine E-Mail hinterlegt'}>Senden</button>
            )}
            {d.number && d.status !== 'aktiv' && (
              <button onClick={sign} disabled={busy} title="Gegenzeichnung / Annahme erfassen">Unterzeichnet</button>
            )}
          </div>

          {locked && (
            <p className="settings-hint">
              Dieser Vertrag ist festgeschrieben ({d.number}). Inhalt und AGB sind eingefroren. Du kannst den
              Vertrag als PDF herunterladen, versenden, als unterzeichnet markieren oder den Status ändern.
            </p>
          )}

          <div className="doc-grid">
            <div className="field">
              <label>Vertragsart</label>
              <select value={d.type} disabled={locked} onChange={(e) => setD({ type: e.target.value })}>
                {config.contractTypes.map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Titel</label>
              <input value={d.title ?? ''} disabled={locked} onChange={(e) => setD({ title: e.target.value })} />
            </div>
            {d.number && (
              <div className="field">
                <label>Status</label>
                <select value={d.status} onChange={(e) => changeStatus(e.target.value)}>
                  {config.contractStatuses.map((st) => (
                    <option key={st} value={st}>{STATUS_LABEL[st] ?? st}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <fieldset className="doc-block">
            <legend>Auftraggeber</legend>
            <div className="field">
              <label>Name / Firma</label>
              <input value={d.client_name ?? ''} disabled={locked} onChange={(e) => setD({ client_name: e.target.value })} />
            </div>
            <div className="row2">
              <div className="field">
                <label>Straße & Hausnr.</label>
                <input value={d.client_address ?? ''} disabled={locked} onChange={(e) => setD({ client_address: e.target.value })} />
              </div>
              <div className="field">
                <label>Kundentyp</label>
                <select value={d.client_type} disabled={locked} onChange={(e) => setD({ client_type: e.target.value })}>
                  {config.clientTypes.map((t) => (
                    <option key={t} value={t}>{CLIENT_TYPE_LABEL[t] ?? t}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="row2">
              <div className="field">
                <label>PLZ</label>
                <input value={d.client_zip ?? ''} disabled={locked} onChange={(e) => setD({ client_zip: e.target.value })} />
              </div>
              <div className="field">
                <label>Ort</label>
                <input value={d.client_city ?? ''} disabled={locked} onChange={(e) => setD({ client_city: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label>E-Mail</label>
              <input value={d.client_email ?? ''} disabled={locked} onChange={(e) => setD({ client_email: e.target.value })} />
            </div>
          </fieldset>

          <fieldset className="doc-block">
            <legend>Inhalt</legend>
            <div className="field">
              <label>Präambel (optional)</label>
              <textarea rows={2} value={d.intro ?? ''} disabled={locked} onChange={(e) => setD({ intro: e.target.value })} />
            </div>
            <div className="field">
              <label>Vertragsgegenstand / Leistungsbeschreibung</label>
              <textarea rows={6} value={d.body ?? ''} disabled={locked} placeholder="Was wird geschuldet? Umfang, Leistungen, Mitwirkungspflichten…" onChange={(e) => setD({ body: e.target.value })} />
            </div>
          </fieldset>

          <fieldset className="doc-block">
            <legend>Vergütung & Laufzeit</legend>
            <div className="row2">
              <div className="field">
                <label>Auftragswert (netto)</label>
                <input defaultValue={centsToInput(d.value_cents ?? 0)} disabled={locked} onBlur={(e) => setD({ value_cents: inputToCents(e.target.value) })} />
              </div>
              <div className="field">
                <label>Brutto</label>
                <input value={euro(gross)} disabled />
              </div>
            </div>
            <div className="doc-grid">
              <label className="check-row">
                <input type="checkbox" checked={!!d.small_business} disabled={locked} onChange={(e) => setD({ small_business: e.target.checked ? 1 : 0 })} />
                Kleinunternehmer §19 (keine USt.)
              </label>
              {!d.small_business && (
                <div className="field">
                  <label>USt-Satz (%)</label>
                  <input type="number" value={d.vat_rate ?? 19} disabled={locked} onChange={(e) => setD({ vat_rate: Number(e.target.value) })} />
                </div>
              )}
            </div>
            <div className="field">
              <label>Zahlungsmodalitäten (Freitext)</label>
              <textarea rows={2} value={d.payment_terms ?? ''} disabled={locked} placeholder="z. B. 50% bei Auftrag, 50% bei Abnahme — oder: monatlich 199 € netto" onChange={(e) => setD({ payment_terms: e.target.value })} />
            </div>
            <div className="row2">
              <div className="field">
                <label>Laufzeitbeginn</label>
                <input type="date" value={d.start_date ?? ''} disabled={locked} onChange={(e) => setD({ start_date: e.target.value })} />
              </div>
              <div className="field">
                <label>Laufzeitende (leer = unbefristet)</label>
                <input type="date" value={d.end_date ?? ''} disabled={locked} onChange={(e) => setD({ end_date: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label>Kündigungsfrist (Freitext)</label>
              <input value={d.notice_period ?? ''} disabled={locked} placeholder="z. B. 3 Monate zum Quartalsende" onChange={(e) => setD({ notice_period: e.target.value })} />
            </div>
          </fieldset>

          {d.signed_at && (
            <p className="settings-hint">
              Unterzeichnet am {fmtDate(d.signed_at)}{d.signed_by ? ` von ${d.signed_by}` : ''}.
            </p>
          )}

          {d.id && (
            <fieldset className="doc-block">
              <legend>Unterschriebenes Dokument</legend>
              {d.has_signed_doc ? (
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <a href={api.signedContractUrl(d.id)} target="_blank" rel="noreferrer">
                    {d.signed_doc_name ?? 'Dokument anzeigen'}
                  </a>
                  {d.signed_doc_size ? <span className="muted" style={{ fontSize: 12 }}>{Math.round(d.signed_doc_size / 1024)} KB</span> : null}
                  <button className="ghost danger-text" onClick={removeSigned} disabled={busy}>Entfernen</button>
                </div>
              ) : (
                <div className="field">
                  <label>Vom Auftraggeber gegengezeichnetes PDF/Scan hochladen</label>
                  <input
                    type="file"
                    accept=".pdf,application/pdf,image/png,image/jpeg,image/webp,image/heic,image/heif,image/tiff"
                    disabled={busy}
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) uploadSigned(f)
                      e.currentTarget.value = ''
                    }}
                  />
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    Das zurückgesendete, unterschriebene Exemplar wird beim Vertrag gespeichert (im Backup enthalten).
                  </div>
                </div>
              )}
            </fieldset>
          )}

          <div className="field">
            <label>Interne Notiz (nicht auf dem PDF)</label>
            <textarea rows={2} value={d.notes ?? ''} disabled={locked} onChange={(e) => setD({ notes: e.target.value })} />
          </div>

          {!d.agb_text && (
            <p className="settings-hint">
              Hinweis: Die AGB werden beim Festschreiben aus den <strong>Einstellungen → Verträge & AGB</strong> übernommen
              und in den Vertrag eingefroren. Ohne hinterlegte AGB enthält das PDF keinen AGB-Abschnitt.
            </p>
          )}
        </div>
      </div>
    )
  }

  // --- list ---
  return (
    <>
      <div className="toolbar">
        <h1 className="page-title">Verträge</h1>
        <span className="user-chip">{rows.length} Verträge</span>
        <div className="spacer" />
        <button className="primary" onClick={() => { setDraft(blankDraft(config)); setMsg(null); setError(null) }}>+ Neuer Vertrag</button>
      </div>

      <div className="content">
        <div className="hint">
          Erstelle Dienst-, Werk- oder Wartungsverträge mit deinen <strong>AGB</strong>. Beim Festschreiben wird eine
          Vertragsnummer vergeben und die AGB eingefroren; nichts wird automatisch versendet. AGB pflegst du unter
          <strong> Einstellungen → Verträge & AGB</strong>.
        </div>
        {error && <div className="section-error">{error}</div>}
        {msg && <div className="section-info">{msg}</div>}

        {rows.length === 0 ? (
          <div className="center-muted">Noch keine Verträge. Lege einen an, z. B. einen Wartungsvertrag für eine Website.</div>
        ) : (
          <div className="table-wrap">
            <table className="leads">
              <thead>
                <tr>
                  <th>Nr. / Titel</th>
                  <th>Kunde</th>
                  <th>Art</th>
                  <th className="num">Wert</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} onClick={() => { setDraft(r); setMsg(null); setError(null) }}>
                    <td data-label="Nr. / Titel" className="cell-primary">
                      {r.number ? <strong>{r.number}</strong> : <em>Entwurf</em>} · {r.title ?? '—'}
                    </td>
                    <td data-label="Kunde">{r.client_name ?? '—'}</td>
                    <td data-label="Art">{typeLabel(r.type)}</td>
                    <td data-label="Wert" className="num">{euro(r.totals.gross_cents)}</td>
                    <td data-label="Status">
                      <span className={`doc-status doc-status-${r.status}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
                    </td>
                    <td data-label="" onClick={(e) => e.stopPropagation()}>
                      <a href={api.contractPdfUrl(r.id)} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
                        <button className="ghost">PDF</button>
                      </a>
                      {!r.number && <button className="ghost" onClick={() => remove(r.id)}>Löschen</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
