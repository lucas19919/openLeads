import { useEffect, useState } from 'react'
import { api } from '../../api'
import type {
  ApiKey,
  IntegrationConnection,
  IntegrationConfigField,
  IntegrationProvider,
  WebhookDelivery,
  WebhookEndpoint,
} from '../../types'

// Admin-only management for the integrations foundation: connect providers,
// mint/revoke public-API keys, and subscribe outbound webhooks. Mirrors the
// SettingsView idioms (doc-block fieldsets, write-only secrets shown once,
// items-table with data-label for the mobile card transform).

const API_SCOPES = ['leads:read', 'leads:write', 'documents:read', 'documents:write']

function statusLabel(s: string): string {
  return s === 'ok' ? 'verbunden' : s === 'error' ? 'Fehler' : 'nicht konfiguriert'
}

export function IntegrationsView() {
  return (
    <>
      <div className="toolbar">
        <span className="page-title">Integrationen</span>
      </div>
      <div className="content">
        <div className="settings-form">
          <ConnectionsSection />
          <ApiKeysSection />
          <WebhooksSection />
        </div>
      </div>
    </>
  )
}

// One-time reveal of a freshly created secret/token (copyable, dismissable).
function SecretReveal({ label, value, onDismiss }: { label: string; value: string; onDismiss: () => void }) {
  return (
    <div className="secret-reveal">
      <span>{label}</span>
      <code>{value}</code>
      <button className="ghost" onClick={() => navigator.clipboard?.writeText(value)}>
        Kopieren
      </button>
      <button className="ghost" onClick={onDismiss}>
        Schließen
      </button>
    </div>
  )
}

// --- Connections ------------------------------------------------------------

function ConnectionsSection() {
  const [providers, setProviders] = useState<IntegrationProvider[]>([])
  const [connections, setConnections] = useState<IntegrationConnection[]>([])
  const [error, setError] = useState<string | null>(null)

  function refresh() {
    api.integrationProviders().then(({ providers }) => setProviders(providers))
      .catch((e) => setError(e instanceof Error ? e.message : 'Anbieter konnten nicht geladen werden.'))
    api.integrationConnections().then(({ connections }) => setConnections(connections))
      .catch((e) => setError(e instanceof Error ? e.message : 'Verbindungen konnten nicht geladen werden.'))
  }
  useEffect(refresh, [])

  const connOf = (p: IntegrationProvider) =>
    connections.find((c) => c.category === p.category && c.provider === p.provider)
  const card = (p: IntegrationProvider, prepared = false) => (
    <ProviderCard
      key={`${p.category}:${p.provider}`}
      provider={p}
      connection={connOf(p)}
      prepared={prepared}
      onChange={refresh}
      onError={setError}
    />
  )
  const wired = providers.filter((p) => p.wired)
  const prepared = providers.filter((p) => !p.wired)

  return (
    <fieldset className="doc-block">
      <legend>Integrationen</legend>
      <p className="settings-hint">
        Externe Anbieter (Zahlung, Buchhaltung, …). Zugangsdaten werden verschlüsselt gespeichert
        (AES-256-GCM) und nie zurückgegeben. Pro Kategorie ist eine Verbindung aktiv.
      </p>
      {error && <div className="section-error">{error}</div>}
      {wired.map((p) => card(p))}
      {prepared.length > 0 && (
        <>
          <div className="int-group-head">Vorbereitet — noch nicht angebunden</div>
          <p className="settings-hint">
            Diese Kategorien sind angelegt, werden aber noch nicht genutzt: Speichern/Aktivieren ist
            möglich, löst aber noch keine Aktion aus. Der <strong>E-Mail-Versand</strong> wird derzeit
            unter <strong>Einstellungen → E-Mail-Versand (SMTP)</strong> konfiguriert, nicht hier.
          </p>
          {prepared.map((p) => card(p, true))}
        </>
      )}
      {providers.length === 0 && <p className="settings-hint">Keine Anbieter registriert.</p>}
    </fieldset>
  )
}

function ProviderCard({
  provider,
  connection,
  prepared = false,
  onChange,
  onError,
}: {
  provider: IntegrationProvider
  connection?: IntegrationConnection
  prepared?: boolean
  onChange: () => void
  onError: (e: string | null) => void
}) {
  const [fields, setFields] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [probe, setProbe] = useState<{ ok: boolean; detail?: string } | null>(null)

  // Seed non-secret config from the stored connection (secrets stay blank).
  useEffect(() => {
    const init: Record<string, string> = {}
    for (const f of provider.configSchema) {
      if (!f.secret && connection && connection.config[f.key] != null) {
        init[f.key] = String(connection.config[f.key])
      }
    }
    setFields(init)
  }, [connection?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const setField = (k: string, v: string) => setFields((cur) => ({ ...cur, [k]: v }))

  async function save() {
    // Validate required fields before hitting the server. A required secret counts
    // as satisfied when one is already stored (credentials_set) — blank means keep.
    const missing = provider.configSchema
      .filter((f) => f.required)
      .filter((f) => {
        const v = fields[f.key]
        if (v !== undefined && String(v).trim() !== '') return false
        if (f.secret && connection?.credentials_set) return false
        return true
      })
      .map((f) => f.label)
    if (missing.length) {
      onError(`Pflichtfelder fehlen: ${missing.join(', ')}.`)
      return
    }
    setBusy(true)
    onError(null)
    setProbe(null)
    try {
      const payload: Record<string, unknown> = {}
      for (const f of provider.configSchema) {
        const raw = fields[f.key]
        if (f.type === 'boolean') {
          payload[f.key] = raw === '1' || raw === 'true'
          continue
        }
        if (raw === undefined || raw === '') continue // skip → keep existing secret
        payload[f.key] = f.type === 'number' ? Number(raw) : raw
      }
      await api.saveIntegration({ category: provider.category, provider: provider.provider, fields: payload })
      // Clear secret inputs after a successful save (never echoed back).
      setFields((cur) => {
        const n = { ...cur }
        for (const f of provider.configSchema) if (f.secret) delete n[f.key]
        return n
      })
      onChange()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function activate() {
    if (!connection) return
    setBusy(true)
    onError(null)
    try {
      await api.activateIntegration(connection.id)
      onChange()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function test() {
    if (!connection) return
    setBusy(true)
    onError(null)
    try {
      const { probe } = await api.probeIntegration(connection.id)
      setProbe(probe)
      onChange()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!connection || !confirm(`${provider.label} entfernen?`)) return
    setBusy(true)
    onError(null)
    try {
      await api.deleteIntegration(connection.id)
      onChange()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // OAuth providers (Google/Microsoft) need a consent round-trip after saving the
  // client_id/secret/redirect_uri — connect opens the provider's consent window.
  const isOAuth = provider.provider === 'google' || provider.provider === 'microsoft'
  async function connectOAuth() {
    if (!connection) {
      onError('Bitte zuerst speichern.')
      return
    }
    setBusy(true)
    onError(null)
    let url: string
    try {
      ;({ url } = await api.startOAuth(connection.id))
    } catch (e) {
      onError((e as Error).message)
      setBusy(false)
      return
    }
    const popup = window.open(url, 'openleads-oauth', 'width=520,height=680')
    if (!popup) {
      onError('Popup wurde blockiert — bitte Popups für diese Seite erlauben.')
      setBusy(false)
      return
    }
    // Refresh the moment the callback page signals completion (postMessage), or
    // when the popup closes, or after a safety timeout — no more blind delay.
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      window.removeEventListener('message', onMsg)
      window.clearInterval(poll)
      window.clearTimeout(timeout)
      setBusy(false)
      onChange()
    }
    const onMsg = (ev: MessageEvent) => {
      if ((ev.data as { source?: string } | null)?.source !== 'openleads-oauth') return
      if ((ev.data as { ok?: boolean }).ok === false) onError('OAuth-Verbindung fehlgeschlagen.')
      finish()
    }
    window.addEventListener('message', onMsg)
    const poll = window.setInterval(() => {
      if (popup.closed) finish()
    }, 700)
    const timeout = window.setTimeout(finish, 180_000)
  }
  async function disconnectAccount() {
    if (!connection) return
    setBusy(true)
    onError(null)
    try {
      await api.disconnectOAuth(connection.id)
      onChange()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="int-card">
      <div className="int-card-head">
        <strong>{provider.label}</strong>
        <span className="muted-mono">{provider.category}</span>
        {prepared && <span className="status-pill unconfigured" title="Noch nicht an eine Aktion angebunden">geplant</span>}
        {connection?.active && <span className="status-pill ok">aktiv</span>}
        {connection && <span className={`status-pill ${connection.status}`}>{statusLabel(connection.status)}</span>}
        {isOAuth && connection?.oauth_connected && (
          <span className="status-pill ok">
            Verbunden{connection.account_email ? ' · ' + connection.account_email : ''}
          </span>
        )}
      </div>
      {connection?.status_detail && <p className="settings-hint">{connection.status_detail}</p>}
      {provider.configSchema.length === 0 && (
        <p className="settings-hint">Keine Konfiguration nötig — Verbindung speichern und aktivieren.</p>
      )}
      {provider.configSchema.map((f) => (
        <FieldInput key={f.key} field={f} value={fields[f.key] ?? ''} credentialsSet={!!connection?.credentials_set} onChange={(v) => setField(f.key, v)} />
      ))}
      <div className="int-card-actions">
        <button className="primary" onClick={save} disabled={busy}>
          Speichern
        </button>
        {connection && !connection.active && (
          <button className="ghost" onClick={activate} disabled={busy}>
            Aktivieren
          </button>
        )}
        {connection && (
          <button className="ghost" onClick={test} disabled={busy}>
            Verbindung testen
          </button>
        )}
        {isOAuth &&
          connection &&
          (connection.oauth_connected ? (
            <button className="ghost" onClick={disconnectAccount} disabled={busy}>
              Abmelden
            </button>
          ) : (
            <button className="ghost" onClick={connectOAuth} disabled={busy}>
              Verbinden
            </button>
          ))}
        {connection && (
          <button className="ghost danger-text" onClick={remove} disabled={busy}>
            Entfernen
          </button>
        )}
      </div>
      {probe && (
        <p className="settings-hint" style={{ color: probe.ok ? 'var(--ok)' : 'var(--danger)' }}>
          {probe.ok ? 'Verbindung ok.' : probe.detail || 'Fehler.'}
        </p>
      )}
    </div>
  )
}

function FieldInput({
  field,
  value,
  credentialsSet,
  onChange,
}: {
  field: IntegrationConfigField
  value: string
  credentialsSet: boolean
  onChange: (v: string) => void
}) {
  if (field.type === 'boolean') {
    return (
      <label className="check-row">
        <input type="checkbox" checked={value === '1'} onChange={(e) => onChange(e.target.checked ? '1' : '')} />
        {field.label}
      </label>
    )
  }
  if (field.type === 'select') {
    return (
      <div className="field">
        <label>
          {field.label}
          {field.required && <span className="req-star" title="Pflichtfeld"> *</span>}
        </label>
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    )
  }
  return (
    <div className="field">
      <label>
        {field.label}
        {field.required && <span className="req-star" title="Pflichtfeld"> *</span>}
        {field.secret && credentialsSet && (
          <span className="user-chip" style={{ marginLeft: 6 }}>
            gespeichert
          </span>
        )}
      </label>
      <input
        type={field.secret ? 'password' : field.type === 'number' ? 'number' : 'text'}
        autoComplete={field.secret ? 'new-password' : 'off'}
        placeholder={field.secret && credentialsSet ? '******** (leer lassen zum Beibehalten)' : field.placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

// --- API keys ---------------------------------------------------------------

function ApiKeysSection() {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [newToken, setNewToken] = useState<string | null>(null)

  const [busy, setBusy] = useState(false)

  function refresh() {
    api.listApiKeys().then(({ keys }) => setKeys(keys))
      .catch((e) => setError(e instanceof Error ? e.message : 'Schlüssel konnten nicht geladen werden.'))
  }
  useEffect(refresh, [])

  const toggleScope = (s: string) =>
    setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))

  async function create() {
    setBusy(true)
    setError(null)
    try {
      const { token } = await api.createApiKey({ name: name.trim() || undefined, scopes })
      setNewToken(token)
      setName('')
      setScopes([])
      refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function revoke(k: ApiKey) {
    if (!confirm(`Schlüssel „${k.name || k.prefix}“ widerrufen? Das ist sofort wirksam.`)) return
    setError(null)
    try {
      await api.revokeApiKey(k.id)
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <fieldset className="doc-block">
      <legend>API-Schlüssel</legend>
      <p className="settings-hint">
        Für die öffentliche API (<code>/api/v1</code>). Der Schlüssel wird nur <strong>einmal</strong>{' '}
        angezeigt — danach nur noch das Präfix. Server-zu-Server, getrennt von der Sitzungsanmeldung.
      </p>
      {error && <div className="section-error">{error}</div>}
      {newToken && <SecretReveal label="Neuer Schlüssel (einmalig):" value={newToken} onDismiss={() => setNewToken(null)} />}
      <div className="table-wrap">
        <table className="items-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Präfix</th>
              <th>Scopes</th>
              <th>Zuletzt</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td data-label="Name" className="cell-primary">
                  {k.name || '—'}
                </td>
                <td data-label="Präfix">
                  <code>ol_{k.prefix}…</code>
                </td>
                <td data-label="Scopes">{k.scopes || '—'}</td>
                <td data-label="Zuletzt">{k.last_used_at ? k.last_used_at.slice(0, 16) : 'nie'}</td>
                <td data-label="Status">
                  {k.revoked_at ? (
                    <span className="status-pill error">widerrufen</span>
                  ) : (
                    <span className="status-pill ok">aktiv</span>
                  )}
                </td>
                <td data-label="">
                  {!k.revoked_at && (
                    <button className="ghost" onClick={() => revoke(k)}>
                      Widerrufen
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {keys.length === 0 && (
              <tr>
                <td colSpan={6} className="center-muted">
                  Noch keine Schlüssel.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="field" style={{ marginTop: 10 }}>
        <label>Name (optional)</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="z.B. Zapier" />
      </div>
      <div className="field">
        <label>Berechtigungen (Scopes)</label>
        <div className="scope-grid">
          {API_SCOPES.map((s) => (
            <label className="check-row" key={s}>
              <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggleScope(s)} />
              <code>{s}</code>
            </label>
          ))}
        </div>
      </div>
      <button className="primary" onClick={create} disabled={busy || scopes.length === 0}>
        {busy ? '…' : 'Schlüssel erzeugen'}
      </button>
    </fieldset>
  )
}

// --- Webhooks ---------------------------------------------------------------

function WebhooksSection() {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([])
  const [events, setEvents] = useState<string[]>([])
  const [url, setUrl] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [desc, setDesc] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [newSecret, setNewSecret] = useState<string | null>(null)
  const [openDeliveries, setOpenDeliveries] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  function refresh() {
    api.listWebhooks().then(({ endpoints }) => setEndpoints(endpoints))
      .catch((e) => setError(e instanceof Error ? e.message : 'Webhooks konnten nicht geladen werden.'))
  }
  useEffect(() => {
    refresh()
    api.webhookEvents().then(({ events }) => setEvents(events)).catch(() => {})
  }, [])

  const toggleEvent = (ev: string) =>
    setSelected((cur) => (cur.includes(ev) ? cur.filter((x) => x !== ev) : [...cur, ev]))

  async function create() {
    setBusy(true)
    setError(null)
    try {
      const { secret } = await api.createWebhook({
        url: url.trim(),
        events: selected.length ? selected.join(',') : '*',
        description: desc.trim() || undefined,
      })
      setNewSecret(secret)
      setUrl('')
      setSelected([])
      setDesc('')
      refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function toggleActive(ep: WebhookEndpoint) {
    setError(null)
    try {
      await api.updateWebhook(ep.id, { active: !ep.active })
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function remove(ep: WebhookEndpoint) {
    if (!confirm(`Webhook ${ep.url} löschen?`)) return
    setError(null)
    try {
      await api.deleteWebhook(ep.id)
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function rotate(ep: WebhookEndpoint) {
    if (!confirm(`Signaturgeheimnis für ${ep.url} neu erzeugen? Das alte wird sofort ungültig.`)) return
    setError(null)
    try {
      const { secret } = await api.rotateWebhookSecret(ep.id)
      setNewSecret(secret)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <fieldset className="doc-block">
      <legend>Webhooks</legend>
      <p className="settings-hint">
        OpenLeads sendet signierte Ereignisse (HMAC) an deine HTTPS-URL. Das Signaturgeheimnis wird
        nur <strong>einmal</strong> angezeigt. Private/lokale Ziele werden abgelehnt.
      </p>
      {error && <div className="section-error">{error}</div>}
      {newSecret && (
        <SecretReveal label="Signaturgeheimnis (einmalig):" value={newSecret} onDismiss={() => setNewSecret(null)} />
      )}
      {endpoints.map((ep) => (
        <div className="int-card" key={ep.id}>
          <div className="int-card-head">
            <strong className="break-all">{ep.url}</strong>
            <span className={`status-pill ${ep.active ? 'ok' : 'unconfigured'}`}>
              {ep.active ? 'aktiv' : 'inaktiv'}
            </span>
          </div>
          <p className="settings-hint">
            Ereignisse: <code>{ep.events}</code>
            {ep.description ? ` · ${ep.description}` : ''}
          </p>
          <div className="int-card-actions">
            <button className="ghost" onClick={() => toggleActive(ep)}>
              {ep.active ? 'Deaktivieren' : 'Aktivieren'}
            </button>
            <button className="ghost" onClick={() => setOpenDeliveries(openDeliveries === ep.id ? null : ep.id)}>
              {openDeliveries === ep.id ? 'Zustellungen ausblenden' : 'Zustellungen'}
            </button>
            <button className="ghost" onClick={() => rotate(ep)}>
              Secret rotieren
            </button>
            <button className="ghost danger-text" onClick={() => remove(ep)}>
              Löschen
            </button>
          </div>
          {openDeliveries === ep.id && <Deliveries endpointId={ep.id} onError={setError} />}
        </div>
      ))}
      {endpoints.length === 0 && <p className="settings-hint">Noch keine Webhooks.</p>}

      <div className="field" style={{ marginTop: 10 }}>
        <label>Ziel-URL (HTTPS)</label>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/webhook" />
      </div>
      <div className="field">
        <label>
          Ereignisse <span className="muted-mono">(keine Auswahl = alle)</span>
        </label>
        <div className="scope-grid">
          {events.map((ev) => (
            <label className="check-row" key={ev}>
              <input type="checkbox" checked={selected.includes(ev)} onChange={() => toggleEvent(ev)} />
              <code>{ev}</code>
            </label>
          ))}
        </div>
      </div>
      <div className="field">
        <label>Beschreibung (optional)</label>
        <input value={desc} onChange={(e) => setDesc(e.target.value)} />
      </div>
      <button className="primary" onClick={create} disabled={busy || !url.trim()}>
        {busy ? '…' : 'Webhook anlegen'}
      </button>
    </fieldset>
  )
}

function Deliveries({ endpointId, onError }: { endpointId: number; onError: (e: string | null) => void }) {
  const [rows, setRows] = useState<WebhookDelivery[]>([])
  function refresh() {
    api.webhookDeliveries(endpointId).then(({ deliveries }) => setRows(deliveries)).catch(() => {})
  }
  useEffect(refresh, [endpointId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function redeliver(id: number) {
    onError(null)
    try {
      await api.redeliverWebhook(id)
      setTimeout(refresh, 800)
    } catch (e) {
      onError((e as Error).message)
    }
  }

  return (
    <div className="table-wrap" style={{ marginTop: 8 }}>
      <table className="items-table">
        <thead>
          <tr>
            <th>Ereignis</th>
            <th>Status</th>
            <th>Versuche</th>
            <th>Code</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id}>
              <td data-label="Ereignis">
                <code>{d.event}</code>
              </td>
              <td data-label="Status">
                <span className={`status-pill ${d.status === 'delivered' ? 'ok' : d.status === 'failed' ? 'error' : 'unconfigured'}`}>
                  {d.status}
                </span>
              </td>
              <td data-label="Versuche">{d.attempts}</td>
              <td data-label="Code">{d.response_code ?? (d.last_error ? '—' : '')}</td>
              <td data-label="">
                <button className="ghost" onClick={() => redeliver(d.id)}>
                  Erneut senden
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="center-muted">
                Keine Zustellungen.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
