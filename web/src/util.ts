import { useEffect, useState } from 'react'

/**
 * True while the viewport is phone-sized. Matches the 720px breakpoint the
 * stylesheet uses, and follows rotation/resize rather than sampling once at
 * mount, so a layout can't be left in the wrong mode.
 */
export function usePhoneViewport(): boolean {
  const [phone, setPhone] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 720px)')
    // Both signals: `change` is the precise one, but it doesn't fire under
    // every viewport-resize mechanism (devtools/CDP metric overrides), and
    // `resize` always does. setState with an unchanged value is a no-op, so
    // the redundancy costs nothing.
    const sync = () => setPhone(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    window.addEventListener('resize', sync)
    return () => {
      mq.removeEventListener('change', sync)
      window.removeEventListener('resize', sync)
    }
  }, [])
  return phone
}

/** Close a modal/drawer on Escape. Pass a stable-enough handler; re-binds on change. */
export function useEscapeKey(onEscape: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEscape()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onEscape])
}

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
