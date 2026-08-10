import type { CSSProperties } from 'react'
import { parseTags } from '../util'
import type { Lead } from '../types'
import { prioColor } from './Board'

/**
 * The phone lead list.
 *
 * Neither desktop view survives a 375px screen: the table reflowed to nine
 * label/value pairs per lead (SCORE 72, MOBIL nein, TAGS —), and the kanban is
 * eight columns across 2470px of sideways scroll whose drag-to-move never
 * fires on touch. Phones get this instead — one scannable card per lead, with
 * the phase dropdown carrying the move that dragging can't.
 */
export function LeadCards({
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
  if (leads.length === 0)
    return <div className="center-muted">Keine Leads in dieser Phase.</div>

  return (
    <div className="lead-cards">
      {leads.map((l) => {
        const tags = parseTags(l.tags)
        const scoreClass = l.score >= 70 ? 'hot' : l.score >= 45 ? 'warm' : ''
        const meta = [l.trade, l.city].filter(Boolean).join(' · ')
        return (
          <div
            key={l.id}
            className="lead-card"
            style={{ ['--prio']: prioColor(l.priority) } as CSSProperties}
            onClick={() => onOpen(l.id)}
          >
            <div className="lead-card-head">
              <span className="company">{l.company ?? '—'}</span>
              <span className={`score ${scoreClass}`}>{l.score}</span>
            </div>
            {meta && <div className="meta">{meta}</div>}
            {tags.length > 0 && (
              <div className="tag-list">
                {tags.map((t) => (
                  <span className="tag" key={t}>
                    {t}
                  </span>
                ))}
              </div>
            )}
            <div className="lead-card-foot">
              <span className={`badge ${l.priority}`}>{l.priority}</span>
              {l.phone && (
                /* On a phone the number should dial, not just sit there. */
                <a
                  className="lead-phone"
                  href={`tel:${l.phone.replace(/[^+\d]/g, '')}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  {l.phone}
                </a>
              )}
            </div>
            <select
              className="lead-phase"
              value={l.stage}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onMove(l.id, e.target.value)}
            >
              {stages.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        )
      })}
    </div>
  )
}
