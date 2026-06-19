import { useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import type { AgentStep, AiStatus, Digest } from '../../types'

interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
  steps?: AgentStep[]
}

const SUGGESTIONS = [
  'Zeig mir die heißesten Leads in der Pipeline.',
  'Qualifiziere den Lead mit der höchsten Punktzahl und schlage den nächsten Schritt vor.',
  'Entwirf eine Erstansprache für einen interessanten Maler-Lead.',
  'Wie viele Leads stehen je Stage?',
]

export function CopilotView() {
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [digest, setDigest] = useState<Digest | null>(null)
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [input, setInput] = useState('')
  const [threadId, setThreadId] = useState<number | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.aiStatus().then(setStatus).catch(() => setStatus(null))
    api.aiDigest().then((r) => setDigest(r.digest)).catch(() => {})
  }, [])
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [turns, busy])

  async function send(text: string) {
    const message = text.trim()
    if (!message || busy) return
    setError(null)
    setInput('')
    setTurns((t) => [...t, { role: 'user', content: message }])
    setBusy(true)
    try {
      const res = await api.aiChat(message, threadId)
      setThreadId(res.thread_id)
      setTurns((t) => [...t, { role: 'assistant', content: res.reply, steps: res.steps }])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="toolbar">
        <span className="page-title">KI-Cockpit</span>
        <div className="spacer" />
        <AiBadge status={status} />
      </div>

      <div className="copilot">
        <div className="copilot-stream">
        {turns.length === 0 && digest && (
          <div className="digest">
            <h2>{digest.headline}</h2>
            {digest.priorities.length === 0 ? (
              <p className="muted">Nichts Dringendes — guter Zeitpunkt für neue Leads.</p>
            ) : (
              <ol className="digest-list">
                {digest.priorities.map((p, i) => (
                  <li key={i} className="digest-item">
                    <div className="digest-title">{p.title}</div>
                    <div className="muted">{p.why}</div>
                    <button className="chip" onClick={() => send(p.action)} disabled={busy}>
                      → {p.action}
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
        {turns.length === 0 && (
          <div className="copilot-empty">
            <p className="muted">
              Dein KI-Kern bedient Leads, Pipeline und Rechnungen — frag einfach. Beispiele:
            </p>
            <div className="copilot-suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip" onClick={() => send(s)} disabled={busy}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`bubble bubble-${t.role}`}>
            {t.steps && t.steps.length > 0 && <StepTrail steps={t.steps} />}
            <div className="bubble-text">{t.content || '—'}</div>
          </div>
        ))}
        {busy && <div className="bubble bubble-assistant"><span className="typing">KI denkt…</span></div>}
        {error && <div className="bubble bubble-error">Fehler: {error}</div>}
        <div ref={endRef} />
      </div>

      <form
        className="copilot-input"
        onSubmit={(e) => {
          e.preventDefault()
          send(input)
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Anweisung an die KI… (z.B. „Qualifiziere Lead 12 und entwirf eine Mail“)"
          disabled={busy}
          autoFocus
        />
        <button type="submit" disabled={busy || !input.trim()}>
          Senden
        </button>
      </form>
      </div>
    </>
  )
}

function StepTrail({ steps }: { steps: AgentStep[] }) {
  return (
    <details className="step-trail">
      <summary>{steps.length} Werkzeug{steps.length > 1 ? 'e' : ''} genutzt</summary>
      <ul>
        {steps.map((s, i) => (
          <li key={i}>
            <code>{s.tool}</code>
            <span className="muted"> {JSON.stringify(s.args)}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}

export function AiBadge({ status }: { status: AiStatus | null }) {
  if (!status) return <span className="ai-badge ai-badge-off">KI: prüfe…</span>
  const cls = status.ok ? (status.local_inference ? 'ai-badge-local' : 'ai-badge-cloud') : 'ai-badge-off'
  const label = status.label || status.model
  return (
    <span className={`ai-badge ${cls}`} title={`${status.base_url}${status.detail ? ` · ${status.detail}` : ''}`}>
      <span className="dot" />
      {status.ok ? label : 'KI offline'}
      {status.ok && (status.local_inference ? ' · lokal' : ' · extern')}
    </span>
  )
}
