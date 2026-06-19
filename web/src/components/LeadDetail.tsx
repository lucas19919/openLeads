import { useEffect, useState } from 'react'
import { api } from '../api'
import { addDaysISO } from '../util'
import type { Lead, LeadAnalysis, LeadEvent, Outreach } from '../types'

// talking_points / risk_flags arrive as JSON strings from the model.
// Parse defensively: never throw, always fall back to an empty list.
function parseList(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

const QUAL_LABELS: Record<string, string> = {
  hot: 'Heiß',
  warm: 'Warm',
  cold: 'Kalt',
  disqualified: 'Disqualifiziert',
}

const OUTREACH_STATUSES: { value: string; label: string }[] = [
  { value: 'entwurf', label: 'Entwurf' },
  { value: 'freigegeben', label: 'Freigegeben' },
  { value: 'gesendet', label: 'Gesendet' },
  { value: 'verworfen', label: 'Verworfen' },
]

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'Unbekannter Fehler'
}

// Imported/scraped websites are often bare domains ("foo.de") with no scheme.
// Without a scheme the browser treats the link as relative — prepend https://.
function toHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`
}

function describe(ev: LeadEvent): string {
  switch (ev.type) {
    case 'created':
      return 'Lead angelegt'
    case 'stage_change':
      return `Phase: ${ev.from_stage} → ${ev.to_stage}`
    case 'note':
      return `Notiz: ${ev.body ?? ''}`
    default:
      return ev.body ?? ev.type
  }
}

export function LeadDetail({
  id,
  stages,
  priorities,
  onClose,
  onChanged,
  onCreateInvoice,
}: {
  id: number
  stages: string[]
  priorities: string[]
  onClose: () => void
  onChanged: (l: Lead) => void
  onCreateInvoice: (l: Lead) => void
}) {
  const [lead, setLead] = useState<Lead | null>(null)
  const [events, setEvents] = useState<LeadEvent[]>([])
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  // KI-Analyse
  const [analysis, setAnalysis] = useState<LeadAnalysis | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [analysisErr, setAnalysisErr] = useState<string | null>(null)

  // Wiedervorlage-Vorschlag (KI)
  const [planning, setPlanning] = useState(false)
  const [planErr, setPlanErr] = useState<string | null>(null)
  const [planMsg, setPlanMsg] = useState<string | null>(null)

  // Ansprache (Outreach)
  const [outreach, setOutreach] = useState<Outreach[]>([])
  const [drafting, setDrafting] = useState(false)
  const [outreachErr, setOutreachErr] = useState<string | null>(null)
  // Versand pro Entwurf: laufender Sendevorgang, Erfolgs- und Fehlermeldung.
  const [sendingId, setSendingId] = useState<number | null>(null)
  const [sentTo, setSentTo] = useState<Record<number, string>>({})
  const [sendErr, setSendErr] = useState<Record<number, string>>({})

  // DSGVO
  const [erasing, setErasing] = useState(false)
  const [dsgvoErr, setDsgvoErr] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    api.getLead(id).then(({ lead, events }) => {
      if (!active) return
      setLead(lead)
      setEvents(events)
      setNotes(lead.notes ?? '')
    })
    api
      .listOutreach(id)
      .then(({ outreach }) => {
        if (active) setOutreach(outreach)
      })
      .catch((e: unknown) => {
        if (active) setOutreachErr(errMsg(e))
      })
    return () => {
      active = false
    }
  }, [id])

  async function runAnalysis() {
    setAnalyzing(true)
    setAnalysisErr(null)
    try {
      const { analysis } = await api.analyzeLead(id)
      setAnalysis(analysis)
    } catch (e) {
      setAnalysisErr(errMsg(e))
    } finally {
      setAnalyzing(false)
    }
  }

  async function planFollowup() {
    setPlanning(true)
    setPlanErr(null)
    setPlanMsg(null)
    try {
      const { suggestion } = await api.planFollowup(id, true)
      setPlanMsg(
        suggestion.recontact_at
          ? `✓ Wiedervorlage: ${suggestion.recontact_at} — ${suggestion.reason}`
          : suggestion.reason,
      )
      // Datum wurde gesetzt – Lead neu laden, damit das Feld aktualisiert wird.
      const { lead } = await api.getLead(id)
      setLead(lead)
      onChanged(lead)
    } catch (e) {
      setPlanErr(errMsg(e))
    } finally {
      setPlanning(false)
    }
  }

  async function createDraft() {
    setDrafting(true)
    setOutreachErr(null)
    try {
      const { outreach: created } = await api.draftOutreach(id, 'email')
      setOutreach((prev) => [created, ...prev])
    } catch (e) {
      setOutreachErr(errMsg(e))
    } finally {
      setDrafting(false)
    }
  }

  async function changeOutreachStatus(o: Outreach, status: string) {
    setOutreachErr(null)
    try {
      const { outreach: updated } = await api.updateOutreach(o.id, { status })
      setOutreach((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))
    } catch (e) {
      setOutreachErr(errMsg(e))
    }
  }

  async function sendOutreach(o: Outreach) {
    setSendingId(o.id)
    setSendErr((prev) => {
      const next = { ...prev }
      delete next[o.id]
      return next
    })
    try {
      const { to } = await api.sendOutreach(o.id)
      setSentTo((prev) => ({ ...prev, [o.id]: to }))
      setOutreach((prev) =>
        prev.map((x) => (x.id === o.id ? { ...x, status: 'gesendet' } : x)),
      )
    } catch (e) {
      setSendErr((prev) => ({ ...prev, [o.id]: errMsg(e) }))
    } finally {
      setSendingId(null)
    }
  }

  async function eraseLead() {
    if (
      !window.confirm(
        'Diesen Lead und alle personenbezogenen Daten endgültig löschen (Art. 17 DSGVO)? ' +
          'Rechtlich aufbewahrungspflichtige Rechnungen werden anonymisiert beibehalten.',
      )
    ) {
      return
    }
    setErasing(true)
    setDsgvoErr(null)
    try {
      const { retained_documents } = await api.dsgvoErase(id)
      if (retained_documents > 0) {
        window.alert(
          `${retained_documents} Rechnung(en) wurden aus gesetzlichen Aufbewahrungsgründen ` +
            'beibehalten und vom Lead entkoppelt.',
        )
      }
      onClose()
    } catch (e) {
      setDsgvoErr(errMsg(e))
    } finally {
      setErasing(false)
    }
  }

  async function patch(p: Partial<Lead>) {
    const { lead } = await api.updateLead(id, p)
    setLead(lead)
    onChanged(lead)
    const fresh = await api.getLead(id)
    setEvents(fresh.events)
  }

  return (
    <>
      <div className="overlay" onClick={onClose} />
      <aside className="drawer">
        {!lead ? (
          <div className="drawer-body center-muted">Lädt…</div>
        ) : (
          <>
            <div className="drawer-head">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <strong style={{ fontSize: 16 }}>{lead.company ?? 'Lead'}</strong>
                <button className="ghost" onClick={onClose}>
                  ✕
                </button>
              </div>
              <div style={{ color: 'var(--muted)', marginTop: 4 }}>
                {[lead.trade, lead.city].filter(Boolean).join(' · ') || '—'}
              </div>
              <div style={{ marginTop: 10 }}>
                <button onClick={() => onCreateInvoice(lead)}>
                  📄 Angebot / Rechnung erstellen
                </button>
              </div>
            </div>

            <div className="drawer-body">
              <div className="row2">
                <div className="field">
                  <label>Phase</label>
                  <select value={lead.stage} onChange={(e) => patch({ stage: e.target.value })}>
                    {stages.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Priorität</label>
                  <select
                    value={lead.priority}
                    onChange={(e) => patch({ priority: e.target.value })}
                  >
                    {priorities.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="field">
                <label>Wiedervorlage / Rückruf</label>
                <input
                  type="date"
                  value={lead.recontact_at ?? ''}
                  onChange={(e) => patch({ recontact_at: e.target.value || null })}
                />
                <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                  <button onClick={() => patch({ recontact_at: addDaysISO(3) })}>+3 Tage</button>
                  <button onClick={() => patch({ recontact_at: addDaysISO(7) })}>+1 Woche</button>
                  <button onClick={() => patch({ recontact_at: addDaysISO(14) })}>+2 Wochen</button>
                  {lead.recontact_at && (
                    <button className="ghost" onClick={() => patch({ recontact_at: null })}>
                      Entfernen
                    </button>
                  )}
                </div>
              </div>

              <div>
                <div className="kv">
                  <span className="k">Score</span>
                  <span>{lead.score}</span>
                </div>
                {lead.website && (
                  <div className="kv">
                    <span className="k">Website</span>
                    <a href={toHref(lead.website)} target="_blank" rel="noopener noreferrer">
                      {lead.website.replace(/^https?:\/\//, '')}
                    </a>
                  </div>
                )}
                {lead.phone && (
                  <div className="kv">
                    <span className="k">Telefon</span>
                    <a href={`tel:${lead.phone}`}>{lead.phone}</a>
                  </div>
                )}
                {lead.email && (
                  <div className="kv">
                    <span className="k">E-Mail</span>
                    <a href={`mailto:${lead.email}`}>{lead.email}</a>
                  </div>
                )}
                {lead.mobile_friendly !== null && (
                  <div className="kv">
                    <span className="k">Mobilfähig</span>
                    <span className={lead.mobile_friendly ? 'mobil-yes' : 'mobil-no'}>
                      {lead.mobile_friendly ? 'ja' : 'nein'}
                    </span>
                  </div>
                )}
                {lead.tech && (
                  <div className="kv">
                    <span className="k">Technik</span>
                    <span>{lead.tech}</span>
                  </div>
                )}
                {lead.staleness_signal && (
                  <div className="kv">
                    <span className="k">Signal</span>
                    <span>{lead.staleness_signal}</span>
                  </div>
                )}
              </div>

              {lead.why_lead && (
                <div className="field">
                  <label>Warum Lead</label>
                  <div>{lead.why_lead}</div>
                </div>
              )}

              <div className="field">
                <label>Notizen</label>
                <textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} />
                <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
                  <button
                    className="primary"
                    disabled={saving || notes === (lead.notes ?? '')}
                    onClick={async () => {
                      setSaving(true)
                      try {
                        await patch({ notes })
                      } finally {
                        setSaving(false)
                      }
                    }}
                  >
                    {saving ? '…' : 'Notiz speichern'}
                  </button>
                </div>
              </div>

              <div className="field ai-section">
                <label>
                  KI-Analyse <span className="ai-badge ai-badge-cloud">KI</span>
                </label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button className="primary" disabled={analyzing} onClick={runAnalysis}>
                    {analyzing ? 'Analysiere…' : 'Lead qualifizieren'}
                  </button>
                  <button disabled={planning} onClick={planFollowup}>
                    {planning ? 'Plane…' : 'Wiedervorlage vorschlagen'}
                  </button>
                </div>
                {analysisErr && (
                  <div className="section-error" role="alert">
                    {analysisErr}
                  </div>
                )}
                {planErr && (
                  <div className="section-error" role="alert">
                    {planErr}
                  </div>
                )}
                {planMsg && (
                  <div className="outreach-sent" role="status">
                    {planMsg}
                  </div>
                )}
                {analysis && (
                  <div className="ai-analysis">
                    {analysis.qualification && (
                      <span className={`qual-badge qual-${analysis.qualification}`}>
                        {QUAL_LABELS[analysis.qualification] ?? analysis.qualification}
                      </span>
                    )}
                    {analysis.fit_score !== null && (
                      <span className="chip" style={{ marginLeft: 6 }}>
                        Fit {analysis.fit_score}/100
                      </span>
                    )}
                    {analysis.summary && <p style={{ margin: '10px 0 0' }}>{analysis.summary}</p>}
                    {analysis.next_action && (
                      <div className="kv" style={{ marginTop: 8 }}>
                        <span className="k">Nächster Schritt</span>
                        <span>{analysis.next_action}</span>
                      </div>
                    )}
                    {parseList(analysis.talking_points).length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        <div className="muted" style={{ fontWeight: 600, marginBottom: 2 }}>
                          Gesprächspunkte
                        </div>
                        <ul style={{ margin: 0, paddingLeft: 18 }}>
                          {parseList(analysis.talking_points).map((t, i) => (
                            <li key={i}>{t}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {parseList(analysis.risk_flags).length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        <div className="muted" style={{ fontWeight: 600, marginBottom: 2 }}>
                          Risiken
                        </div>
                        <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--danger)' }}>
                          {parseList(analysis.risk_flags).map((t, i) => (
                            <li key={i}>{t}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {analysis.model && (
                      <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
                        Modell: {analysis.model}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="field ai-section">
                <label>
                  Ansprache (Entwurf) <span className="ai-badge ai-badge-cloud">KI</span>
                </label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button className="primary" disabled={drafting} onClick={createDraft}>
                    {drafting ? 'Erstelle…' : 'Entwurf erstellen'}
                  </button>
                </div>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  Entwürfe werden niemals automatisch versendet (UWG §7). Ein Mensch prüft und gibt
                  jede Ansprache frei. Erst nach der Freigabe lässt sich „Jetzt senden" nutzen;
                  Impressum und Abmelde-Hinweis (Opt-out) werden dabei automatisch angehängt.
                </div>
                {outreachErr && (
                  <div className="section-error" role="alert">
                    {outreachErr}
                  </div>
                )}
                {outreach.map((o) => (
                  <div className="outreach-card" key={o.id}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      <span className="muted" style={{ fontSize: 12 }}>
                        {o.channel}
                        {o.legal_basis ? ` · ${o.legal_basis}` : ''}
                      </span>
                      <select
                        value={o.status}
                        onChange={(e) => changeOutreachStatus(o, e.target.value)}
                      >
                        {OUTREACH_STATUSES.map((s) => (
                          <option key={s.value} value={s.value}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    {o.subject && (
                      <div style={{ fontWeight: 600, marginTop: 6 }}>{o.subject}</div>
                    )}
                    <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{o.body}</div>
                    {o.status === 'freigegeben' && (
                      <div style={{ marginTop: 10 }}>
                        <button
                          className="primary"
                          disabled={sendingId === o.id}
                          onClick={() => sendOutreach(o)}
                        >
                          {sendingId === o.id ? 'Sende…' : 'Jetzt senden'}
                        </button>
                      </div>
                    )}
                    {sentTo[o.id] && (
                      <div className="outreach-sent" role="status">
                        ✓ Gesendet an {sentTo[o.id]}
                      </div>
                    )}
                    {sendErr[o.id] && (
                      <div className="section-error" role="alert">
                        {sendErr[o.id]}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="field ai-section">
                <label>DSGVO</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <a
                    className="chip"
                    href={api.dsgvoExportUrl(id)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Daten exportieren (JSON)
                  </a>
                  <button className="danger" disabled={erasing} onClick={eraseLead}>
                    {erasing ? 'Lösche…' : 'Löschen (Art. 17)'}
                  </button>
                </div>
                {dsgvoErr && (
                  <div className="section-error" role="alert">
                    {dsgvoErr}
                  </div>
                )}
              </div>

              <div className="field">
                <label>Verlauf</label>
                <div className="timeline">
                  {events.map((ev) => (
                    <div className="event" key={ev.id}>
                      <div>{describe(ev)}</div>
                      <div className="when">
                        {ev.at}
                        {ev.actor ? ` · ${ev.actor}` : ''}
                      </div>
                    </div>
                  ))}
                  {events.length === 0 && (
                    <div className="center-muted">Noch keine Aktivität.</div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </aside>
    </>
  )
}
