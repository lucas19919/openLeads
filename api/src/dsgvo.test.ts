import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emailBlockedByConsent } from './dsgvo'

test('no consent records → e-mail not blocked', () => {
  assert.equal(emailBlockedByConsent([]), false)
})

test('active e-mail consent → not blocked', () => {
  assert.equal(
    emailBlockedByConsent([{ type: 'email_marketing', status: 'active', at: '2026-01-01 10:00:00' }]),
    false,
  )
})

test('withdrawn e-mail consent → blocked', () => {
  assert.equal(
    emailBlockedByConsent([{ type: 'email_marketing', status: 'withdrawn', at: '2026-01-01 10:00:00' }]),
    true,
  )
})

test('withdrawn data_processing consent → blocks e-mail too', () => {
  assert.equal(
    emailBlockedByConsent([{ type: 'data_processing', status: 'withdrawn', at: '2026-01-01 10:00:00' }]),
    true,
  )
})

test('phone-only withdrawal does NOT block e-mail', () => {
  assert.equal(
    emailBlockedByConsent([{ type: 'phone_b2b', status: 'withdrawn', at: '2026-01-01 10:00:00' }]),
    false,
  )
})

test('later re-consent un-blocks an earlier withdrawal (latest per type wins)', () => {
  assert.equal(
    emailBlockedByConsent([
      { type: 'email_marketing', status: 'withdrawn', at: '2026-01-01 10:00:00' },
      { type: 'email_marketing', status: 'active', at: '2026-02-01 10:00:00' },
    ]),
    false,
  )
})

test('later withdrawal beats an earlier active consent', () => {
  assert.equal(
    emailBlockedByConsent([
      { type: 'email_marketing', status: 'active', at: '2026-01-01 10:00:00' },
      { type: 'email_marketing', status: 'withdrawn', at: '2026-03-01 10:00:00' },
    ]),
    true,
  )
})

test('phone withdrawal + active e-mail → not blocked', () => {
  assert.equal(
    emailBlockedByConsent([
      { type: 'phone_b2b', status: 'withdrawn', at: '2026-01-01 10:00:00' },
      { type: 'email_marketing', status: 'active', at: '2026-01-01 10:00:00' },
    ]),
    false,
  )
})
