import { useState, type CSSProperties } from 'react'
import { parseTags } from '../util'
import type { Lead } from '../types'

function prioColor(p: string) {
  return p === 'hoch' ? '#c0392b' : p === 'mittel' ? '#d98324' : '#9aa7b2'
}

function Card({ lead, onOpen }: { lead: Lead; onOpen: (id: number) => void }) {
  const scoreClass = lead.score >= 70 ? 'hot' : lead.score >= 45 ? 'warm' : ''
  const tags = parseTags(lead.tags)
  return (
    <div
      className="card"
      draggable
      style={{ ['--prio']: prioColor(lead.priority) } as CSSProperties}
      onDragStart={(e) => e.dataTransfer.setData('text/plain', String(lead.id))}
      onClick={() => onOpen(lead.id)}
    >
      <div className="company">{lead.company ?? '—'}</div>
      <div className="meta">
        {lead.trade && <span>{lead.trade}</span>}
        {lead.city && <span>· {lead.city}</span>}
      </div>
      {tags.length > 0 && (
        <div className="tag-list">
          {tags.map((t) => (
            <span className="tag" key={t}>
              {t}
            </span>
          ))}
        </div>
      )}
      <div className="card-foot">
        <span className={`badge ${lead.priority}`}>{lead.priority}</span>
        <span className={`score ${scoreClass}`}>{lead.score}</span>
      </div>
    </div>
  )
}

export function Board({
  stages,
  leads,
  onOpen,
  onMove,
}: {
  stages: string[]
  leads: Lead[]
  onOpen: (id: number) => void
  onMove: (id: number, stage: string) => void
}) {
  const [over, setOver] = useState<string | null>(null)
  return (
    <div className="board">
      {stages.map((stage) => {
        const items = leads.filter((l) => l.stage === stage)
        return (
          <div
            key={stage}
            className={`column${over === stage ? ' drop-target' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setOver(stage)
            }}
            onDragLeave={() => setOver((o) => (o === stage ? null : o))}
            onDrop={(e) => {
              e.preventDefault()
              setOver(null)
              const id = Number(e.dataTransfer.getData('text/plain'))
              if (id) onMove(id, stage)
            }}
          >
            <div className="column-head">
              <span>{stage}</span>
              <span className="count">{items.length}</span>
            </div>
            <div className="column-cards">
              {items.map((l) => (
                <Card key={l.id} lead={l} onOpen={onOpen} />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
