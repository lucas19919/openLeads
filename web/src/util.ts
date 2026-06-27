// Local-date helpers (not UTC) so "today" matches the user's timezone.
function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`
}

export function todayISO(): string {
  return iso(new Date())
}

/** YYYY-MM-DD → DD.MM.YYYY for display. */
export function fmtDate(date: string): string {
  const [y, m, d] = date.split('-')
  return d && m && y ? `${d}.${m}.${y}` : date
}

/** Split a stored comma-separated tag string into a clean list. */
export function parseTags(tags?: string | null): string[] {
  if (!tags) return []
  return tags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}
