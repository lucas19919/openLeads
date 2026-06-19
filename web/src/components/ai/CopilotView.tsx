import { useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import type { AiStatus, AiThread, Digest } from '../../types'

type ToolStep = { tool: string; args: Record<string, unknown> }

interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
  steps?: ToolStep[]
}

const SUGGESTIONS = [
  'Zeig mir die heißesten Leads in der Pipeline.',
  'Qualifiziere den Lead mit der höchsten Punktzahl und schlage den nächsten Schritt vor.',
  'Entwirf eine Erstansprache für einen interessanten Maler-Lead.',
  'Wie viele Leads stehen je Stage?',
]

/** SQLite stores UTC "YYYY-MM-DD HH:MM:SS" — show local time, date if not today. */
function fmtWhen(s: string): string {
  const d = new Date(s.replace(' ', 'T') + 'Z')
  if (isNaN(d.getTime())) return s
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString()
}

export function CopilotView() {
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [digest, setDigest] = useState<Digest | null>(null)
  const [threads, setThreads] = useState<AiThread[]>([])
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [input, setInput] = useState('')
  const [threadId, setThreadId] = useState<number | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const loadThreads = () =>
    api.aiThreads().then((r) => setThreads(r.threads)).catch(() => {})

  useEffect(() => {
    api.aiStatus().then(setStatus).catch(() => setStatus(null))
    api.aiDigest().then((r) => setDigest(r.digest)).catch(() => {})
    loadThreads()
  }, [])
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [turns, busy])

  function newChat() {
    if (busy) return
    setTurns([])
    setThreadId(undefined)
    setInput('')
    setError(null)
    inputRef.current?.focus()
  }

  async function openThread(id: number) {
    if (busy || id === threadId) return
    setError(null)
    try {
      const { messages } = await api.aiThread(id)
      const loaded: ChatTurn[] = []
      for (const m of messages) {
        if (m.role !== 'user' && m.role !== 'assistant') continue
        let steps: ToolStep[] | undefined
        if (m.role === 'assistant' && m.tool_calls) {
          try {
            steps = JSON.parse(m.tool_calls) as ToolStep[]
          } catch {
            /* ignore malformed trail */
          }
        }
        loaded.push({ role: m.role, content: m.content, steps })
      }
      setTurns(loaded)
      setThreadId(id)
    } catch (e) {
      setError((e as Error).message)
    }
  }

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
      loadThreads()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="toolbar">
        <span className="page-title">Chat</span>
        <div className="spacer" />
        <AiBadge status={status} />
      </div>

      <div className="chat-shell">
        <aside className="chat-sidebar">
          <button className="chat-new" onClick={newChat} disabled={busy}>
            + Neuer Chat
          </button>
          <div className="chat-thread-list">
            {threads.length === 0 ? (
              <p className="muted chat-thread-empty">Noch keine Unterhaltungen.</p>
            ) : (
              threads.map((th) => (
                <button
                  key={th.id}
                  className={`chat-thread${th.id === threadId ? ' active' : ''}`}
                  onClick={() => openThread(th.id)}
                  disabled={busy}
                >
                  <span className="chat-thread-title">{th.title || 'Unterhaltung'}</span>
                  <span className="chat-thread-when">{fmtWhen(th.updated_at)}</span>
                </button>
              ))
            )}
          </div>
        </aside>

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
                Frag die KI nach Leads, Pipeline und Rechnungen — sie bedient OpenLeads für dich. Beispiele:
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
            ref={inputRef}
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
      </div>
    </>
  )
}

function StepTrail({ steps }: { steps: ToolStep[] }) {
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
