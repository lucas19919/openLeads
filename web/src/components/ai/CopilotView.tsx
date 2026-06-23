import { createElement, useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '../../api'
import type { AiStatus, AiThread, Digest } from '../../types'

type ToolStep = { tool: string; args: Record<string, unknown> }

interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
  steps?: ToolStep[]
}

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
                        {p.action}
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
                Frag die KI nach Leads, Pipeline und Rechnungen — sie bedient OpenLeads für dich.
              </p>
            </div>
          )}
          {turns.map((t, i) => (
            <div key={i} className={`bubble bubble-${t.role}`}>
              {t.steps && t.steps.length > 0 && <StepTrail steps={t.steps} />}
              <div className="bubble-text">
                {t.role === 'assistant' ? <Markdown text={t.content || '—'} /> : t.content || '—'}
              </div>
            </div>
          ))}
          {busy && (
            <div className="bubble bubble-assistant">
              <span className="thinking" aria-label="KI denkt">
                <span className="thinking-dots"><i /><i /><i /></span>
                KI denkt…
              </span>
            </div>
          )}
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

// --- Minimal Markdown -------------------------------------------------------
// The model answers in Markdown (bold, links, lists, headings). We render the
// common subset to React nodes — no dependency, and no dangerouslySetInnerHTML,
// so untrusted model output can't inject HTML. Anything unrecognised falls
// through as plain text.

function safeHref(url: string): string | null {
  const u = (url || '').trim()
  if (/^(https?:|mailto:|tel:)/i.test(u)) return u
  if (/^www\.[\w.-]+\.[a-z]{2,}/i.test(u)) return 'https://' + u
  return null
}

const INLINE_RULES: { re: RegExp; kind: 'code' | 'link' | 'bold' | 'em' }[] = [
  { re: /`([^`]+)`/, kind: 'code' },
  { re: /\[([^\]]*)\]\(([^)]+)\)/, kind: 'link' },
  { re: /\*\*([\s\S]+?)\*\*/, kind: 'bold' },
  { re: /__([\s\S]+?)__/, kind: 'bold' },
  { re: /\*([\s\S]+?)\*/, kind: 'em' },
]

function renderInline(text: string, kp: string): ReactNode[] {
  const out: ReactNode[] = []
  let rest = text
  let guard = 0
  while (rest && guard++ < 500) {
    let best: { idx: number; kind: string; m: RegExpExecArray } | null = null
    for (const rule of INLINE_RULES) {
      const m = rule.re.exec(rest)
      if (m && (best === null || m.index < best.idx)) best = { idx: m.index, kind: rule.kind, m }
    }
    if (!best) break
    if (best.idx > 0) out.push(rest.slice(0, best.idx))
    const { m, kind } = best
    const key = `${kp}-${out.length}`
    if (kind === 'code') out.push(<code key={key}>{m[1]}</code>)
    else if (kind === 'link') {
      const href = safeHref(m[2])
      out.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer">
            {renderInline(m[1], key)}
          </a>
        ) : (
          m[0]
        ),
      )
    } else if (kind === 'bold') out.push(<strong key={key}>{renderInline(m[1], key)}</strong>)
    else out.push(<em key={key}>{renderInline(m[1], key)}</em>)
    rest = rest.slice(best.idx + m[0].length)
  }
  if (rest) out.push(rest)
  return out
}

function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let bk = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      const level = Math.min(h[1].length, 4)
      blocks.push(createElement(`h${level}`, { key: `b${bk++}` }, renderInline(h[2], `h${bk}`)))
      i++
      continue
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: ReactNode[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(<li key={`li${i}`}>{renderInline(lines[i].replace(/^\s*[-*+]\s+/, ''), `li${i}`)}</li>)
        i++
      }
      blocks.push(<ul key={`b${bk++}`}>{items}</ul>)
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const start = Number(/^\s*(\d+)\./.exec(line)![1])
      const items: ReactNode[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(<li key={`li${i}`}>{renderInline(lines[i].replace(/^\s*\d+\.\s+/, ''), `li${i}`)}</li>)
        i++
      }
      blocks.push(
        <ol key={`b${bk++}`} start={Number.isFinite(start) ? start : 1}>
          {items}
        </ol>,
      )
      continue
    }
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^#{1,6}\s+/.test(lines[i])
    ) {
      para.push(lines[i])
      i++
    }
    const nodes: ReactNode[] = []
    para.forEach((p, idx) => {
      if (idx > 0) nodes.push(<br key={`br${bk}-${idx}`} />)
      nodes.push(...renderInline(p, `p${bk}-${idx}`))
    })
    blocks.push(<p key={`b${bk++}`}>{nodes}</p>)
  }
  return <div className="md">{blocks}</div>
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
