import { basename } from 'node:path'
import { readFile } from 'node:fs/promises'

// A thin, typed wrapper over the OpenLeads REST API. Everything the CLI and the
// MCP server do goes through here, so both speak to the server exactly the same
// way: bearer token, JSON in, JSON (or a file) out, one place that turns HTTP
// status codes into exit codes.

/** Exit codes, so scripts can branch on *why* a command failed. */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  AUTH: 3,
  NOT_FOUND: 4,
  INVALID: 5,
  NETWORK: 6,
} as const

export class CliError extends Error {
  code: number
  constructor(message: string, code: number = EXIT.ERROR) {
    super(message)
    this.code = code
  }
}

export class ApiError extends CliError {
  status: number
  constructor(status: number, message: string) {
    super(message, statusToExit(status))
    this.status = status
  }
}

function statusToExit(status: number): number {
  if (status === 401 || status === 403) return EXIT.AUTH
  if (status === 404) return EXIT.NOT_FOUND
  if (status >= 400 && status < 500) return EXIT.INVALID
  return EXIT.ERROR
}

export interface FileResponse {
  data: Buffer
  filename: string
  mime: string
}

export type Query = Record<string, string | number | boolean | undefined | null>

const DEFAULT_TIMEOUT_MS = 30_000
/** Model calls run against whatever Ollama/vLLM the server points at — be patient. */
export const AI_TIMEOUT_MS = 180_000

export class Client {
  constructor(
    readonly baseUrl: string,
    private readonly token: string | undefined,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json', ...extra }
    if (this.token) h.Authorization = `Bearer ${this.token}`
    return h
  }

  private url(path: string, query?: Query): string {
    const u = new URL(`/api${path}`, this.baseUrl)
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v))
    }
    return u.toString()
  }

  private async send(
    method: string,
    path: string,
    init: { query?: Query; body?: unknown; form?: FormData; timeoutMs?: number } = {},
  ): Promise<Response> {
    const headers = this.headers()
    let body: string | FormData | undefined
    if (init.form) {
      body = init.form // fetch sets the multipart boundary itself
    } else if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(init.body)
    }

    let res: Response
    try {
      res = await fetch(this.url(path, init.query), {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(init.timeoutMs ?? this.timeoutMs),
      })
    } catch (e) {
      const err = e as Error
      const hint =
        err.name === 'TimeoutError'
          ? `Zeitüberschreitung nach ${(init.timeoutMs ?? this.timeoutMs) / 1000}s`
          : `${this.baseUrl} nicht erreichbar (${err.message})`
      throw new CliError(hint, EXIT.NETWORK)
    }

    if (!res.ok) throw new ApiError(res.status, await errorMessage(res))
    return res
  }

  async get<T>(path: string, query?: Query): Promise<T> {
    return (await this.send('GET', path, { query })).json() as Promise<T>
  }

  async post<T>(path: string, body?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
    const res = await this.send('POST', path, { body: body ?? {}, timeoutMs: opts.timeoutMs })
    return (res.status === 204 ? undefined : await res.json()) as T
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return (await this.send('PATCH', path, { body })).json() as Promise<T>
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return (await this.send('PUT', path, { body })).json() as Promise<T>
  }

  async delete<T>(path: string): Promise<T> {
    const res = await this.send('DELETE', path)
    return (res.status === 204 ? undefined : await res.json()) as T
  }

  /** Text endpoints — the CSV exports. */
  async getText(path: string, query?: Query): Promise<string> {
    return (await this.send('GET', path, { query })).text()
  }

  /** Binary endpoints — PDFs, receipts, backup snapshots. */
  async getFile(path: string, query?: Query): Promise<FileResponse> {
    const res = await this.send('GET', path, { query, timeoutMs: 120_000 })
    return {
      data: Buffer.from(await res.arrayBuffer()),
      filename: filenameFromDisposition(res.headers.get('content-disposition')) ?? basename(path),
      mime: res.headers.get('content-type') ?? 'application/octet-stream',
    }
  }

  /** multipart/form-data upload — lead imports, receipts, restore. */
  async postFile<T>(path: string, filePath: string, field = 'file'): Promise<T> {
    let data: Buffer
    try {
      data = await readFile(filePath)
    } catch {
      throw new CliError(`Datei nicht lesbar: ${filePath}`, EXIT.USAGE)
    }
    const form = new FormData()
    // The type matters: the receipt and signed-document endpoints validate it
    // against an allow-list, and a Blob without one arrives as
    // application/octet-stream and is refused.
    const blob = new Blob([new Uint8Array(data)], { type: mimeFor(filePath) })
    form.append(field, blob, basename(filePath))
    const res = await this.send('POST', path, { form, timeoutMs: 300_000 })
    return (await res.json()) as T
  }
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string }
    if (body?.error) return body.error
  } catch {
    /* not JSON — fall through */
  }
  if (res.status === 401) return 'Nicht authentifiziert — Token fehlt oder ist ungültig.'
  if (res.status === 403) return 'Nicht erlaubt — fehlende Rechte oder Nur-Lese-Token.'
  return `HTTP ${res.status} ${res.statusText}`.trim()
}

// Enough to cover what the API accepts: receipts and signed documents (PDF or a
// scan), the .xlsx lead import, and a .db snapshot for restore.
const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  gif: 'image/gif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  db: 'application/octet-stream',
}

export function mimeFor(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream'
}

function filenameFromDisposition(header: string | null): string | undefined {
  if (!header) return undefined
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (star) return decodeURIComponent(star[1])
  const plain = /filename="?([^";]+)"?/i.exec(header)
  return plain?.[1]
}
