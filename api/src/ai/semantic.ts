import { db, type LeadRow } from '../db'
import { embed, cosine, AI } from './provider'

// Semantic lead search. Embeds a compact text per lead, stores the vector, and
// ranks by cosine similarity to the query embedding. Small datasets → a linear
// scan in JS beats pulling in a vector database. Degrades to nothing (caller
// falls back to SQL search) when the embedding model is unavailable.

/** The text we embed for a lead — the fields that carry sales meaning. */
export function embedText(lead: LeadRow): string {
  return [
    lead.company,
    lead.trade,
    lead.city,
    lead.tech,
    lead.staleness_signal,
    lead.why_lead,
    lead.notes,
  ]
    .filter(Boolean)
    .join(' · ')
}

interface StoredVec {
  lead_id: number
  vector: string
  dim: number
}

/** (Re)embed leads that are missing or stale. Returns how many were indexed. */
export async function reindexLeads(opts: { all?: boolean } = {}): Promise<{ indexed: number; model: string }> {
  const rows = (opts.all
    ? db.prepare('SELECT * FROM leads').all()
    : db
        .prepare(
          `SELECT l.* FROM leads l
             LEFT JOIN lead_embeddings e ON e.lead_id = l.id
            WHERE e.lead_id IS NULL OR e.updated_at < l.updated_at OR e.model != ?`,
        )
        .all(AI.embedModel)) as unknown as LeadRow[]
  if (rows.length === 0) return { indexed: 0, model: AI.embedModel }

  let indexed = 0
  // Batch to keep requests reasonable for local servers.
  for (let i = 0; i < rows.length; i += 32) {
    const batch = rows.slice(i, i + 32)
    const texts = batch.map(embedText)
    const vecs = await embed(texts)
    const ins = db.prepare(
      `INSERT INTO lead_embeddings (lead_id, vector, dim, model, source, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(lead_id) DO UPDATE SET
         vector=excluded.vector, dim=excluded.dim, model=excluded.model,
         source=excluded.source, updated_at=datetime('now')`,
    )
    batch.forEach((lead, j) => {
      const v = vecs[j]
      if (!v) return
      ins.run(lead.id, JSON.stringify(v), v.length, AI.embedModel, texts[j])
      indexed++
    })
  }
  return { indexed, model: AI.embedModel }
}

export interface SemanticHit {
  lead: LeadRow
  score: number
}

/**
 * Rank leads by semantic similarity to `query`. Embeds any missing leads first
 * so search is complete. Throws (caller falls back) if embeddings are down.
 */
export async function searchLeads(query: string, limit = 15): Promise<SemanticHit[]> {
  await reindexLeads() // keep the index fresh for new/changed leads
  const [qVec] = await embed([query])
  if (!qVec) return []

  const stored = db.prepare('SELECT lead_id, vector, dim FROM lead_embeddings').all() as unknown as StoredVec[]
  const scores: { lead_id: number; score: number }[] = []
  for (const s of stored) {
    if (s.dim !== qVec.length) continue // model changed; skip until reindex
    let vec: number[]
    try {
      vec = JSON.parse(s.vector) as number[]
    } catch {
      continue
    }
    scores.push({ lead_id: s.lead_id, score: cosine(qVec, vec) })
  }
  scores.sort((a, b) => b.score - a.score)
  const top = scores.slice(0, limit)
  const byId = new Map(top.map((t) => [t.lead_id, t.score]))
  if (top.length === 0) return []
  const placeholders = top.map(() => '?').join(',')
  const leads = db
    .prepare(`SELECT * FROM leads WHERE id IN (${placeholders})`)
    .all(...top.map((t) => t.lead_id)) as unknown as LeadRow[]
  return leads
    .map((lead) => ({ lead, score: byId.get(lead.id) ?? 0 }))
    .sort((a, b) => b.score - a.score)
}
