import { useState, type ReactNode } from 'react'

/**
 * Explainer text and power-user panels that are welcome on a wide screen but
 * bury the actual list on a phone (the KI-Rechnung box pushed the invoice
 * table 59% down a 375px viewport). Open by default on desktop, collapsed on
 * phones — either way it's one native <details>, so the user's choice sticks
 * for as long as the view is mounted.
 */
export function Disclosure({
  summary,
  children,
  className = '',
}: {
  summary: ReactNode
  children: ReactNode
  className?: string
}) {
  const [open, setOpen] = useState(
    () => typeof window === 'undefined' || window.innerWidth > 720,
  )
  return (
    <details
      className={`disclosure ${className}`.trim()}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="disclosure-summary">{summary}</summary>
      <div className="disclosure-body">{children}</div>
    </details>
  )
}
