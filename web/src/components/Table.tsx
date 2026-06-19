import { parseTags } from '../util'
import type { Lead } from '../types'

export function Table({
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
  return (
    <div className="table-wrap">
    <table className="leads">
      <thead>
        <tr>
          <th>Firma</th>
          <th>Gewerk</th>
          <th>Ort</th>
          <th>Score</th>
          <th>Prio</th>
          <th>Mobil</th>
          <th>Telefon</th>
          <th>Tags</th>
          <th>Phase</th>
        </tr>
      </thead>
      <tbody>
        {leads.map((l) => (
          <tr key={l.id} onClick={() => onOpen(l.id)}>
            <td>{l.company ?? '—'}</td>
            <td>{l.trade ?? '—'}</td>
            <td>{l.city ?? '—'}</td>
            <td className="no-x">{l.score}</td>
            <td>
              <span className={`badge ${l.priority}`}>{l.priority}</span>
            </td>
            <td>
              {l.mobile_friendly === 0 ? (
                <span className="mobil-no">nein</span>
              ) : l.mobile_friendly === 1 ? (
                <span className="mobil-yes">ja</span>
              ) : (
                '—'
              )}
            </td>
            <td>{l.phone ?? '—'}</td>
            <td>
              {parseTags(l.tags).length > 0 ? (
                <div className="tag-list">
                  {parseTags(l.tags).map((t) => (
                    <span className="tag" key={t}>
                      {t}
                    </span>
                  ))}
                </div>
              ) : (
                '—'
              )}
            </td>
            <td onClick={(e) => e.stopPropagation()}>
              <select value={l.stage} onChange={(e) => onMove(l.id, e.target.value)}>
                {stages.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  )
}
