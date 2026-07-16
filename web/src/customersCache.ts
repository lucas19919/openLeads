import { api } from './api'
import type { Customer } from './types'

/** Shared active-customers list so every CustomerPicker / filter doesn't re-fetch. */
let cache: { at: number; customers: Customer[] } | null = null
const TTL_MS = 30_000
const inflight = new Map<string, Promise<Customer[]>>()

export async function getActiveCustomers(force = false): Promise<Customer[]> {
  const now = Date.now()
  if (!force && cache && now - cache.at < TTL_MS) return cache.customers

  const key = 'active'
  let p = inflight.get(key)
  if (!p) {
    p = api
      .listCustomers(true)
      .then(({ customers }) => {
        cache = { at: Date.now(), customers }
        return customers
      })
      .finally(() => {
        inflight.delete(key)
      })
    inflight.set(key, p)
  }
  return p
}

export function invalidateCustomersCache(): void {
  cache = null
}
