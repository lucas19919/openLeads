// Domain-event hook. The outbound-webhook subsystem was removed when the app was
// streamlined, but the write paths still announce their domain events through
// emit() so the seam stays in one place. It is intentionally a no-op now; wire a
// consumer here if event fan-out is ever needed again. Never throws.
export function emit(_event: string, _data: Record<string, unknown>): void {
  // no-op
}
