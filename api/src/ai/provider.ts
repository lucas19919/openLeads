import '../env'
import type { ChatMessage, ChatResult, ToolSchema } from './types'

// --- Provider configuration ------------------------------------------------
//
// OpenLeads talks to ONE protocol (OpenAI-compatible /chat/completions) and is
// therefore portable across every serving stack. The defaults point at a local
// Ollama so a fresh self-host is AI-capable with zero cloud accounts and zero
// data egress.
//
// Recommended open, German-capable models (set AI_MODEL accordingly):
//   • llama3.1:8b-instruct        — solid all-rounder, good German
//   • qwen2.5:7b-instruct         — strong reasoning + tool calling
//   • mistral-small:latest        — Apache-2.0, excellent German
//   • "openGPT-X/Teuken-7B-instruct-commercial-v0.4" (vLLM) — EU project,
//                                    trained on all 24 EU languages
//   • "utter-project/EuroLLM-9B-Instruct" (vLLM) — EU multilingual
//
// For a managed EU-hosted open model, point AI_BASE_URL at e.g. Mistral
// (https://api.mistral.ai/v1) or an EU IONOS/OVH inference endpoint and set
// AI_API_KEY.

export const AI = {
  baseUrl: (process.env.AI_BASE_URL ?? 'http://localhost:11434/v1').replace(/\/$/, ''),
  model: process.env.AI_MODEL ?? 'llama3.1:8b',
  apiKey: process.env.AI_API_KEY ?? '',
  // A short human label for the UI ("Llama 3.1 · self-hosted"). Informational.
  label: process.env.AI_LABEL ?? '',
  temperature: Number(process.env.AI_TEMPERATURE ?? 0.3),
  maxTokens: Number(process.env.AI_MAX_TOKENS ?? 1024),
  timeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 120_000),
  // Embeddings (semantic search). Defaults to a local Ollama embed model.
  // `ollama pull nomic-embed-text` covers German well enough for lead search.
  embedModel: process.env.AI_EMBED_MODEL ?? 'nomic-embed-text',
} as const

/** True when inference stays on infrastructure the operator controls (no egress
 *  to a third country). Drives the DSGVO data-flow badge in the UI. */
export function isLocalInference(): boolean {
  try {
    const h = new URL(AI.baseUrl).hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local') ||
      h.endsWith('.internal') || /^10\./.test(h) || /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  } catch {
    return false
  }
}

export interface ChatOptions {
  messages: ChatMessage[]
  tools?: ToolSchema[]
  /** Force the model to answer with a single JSON object. */
  json?: boolean
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

export class AIError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'AIError'
  }
}

interface RawChoice {
  message: ChatMessage
  finish_reason: string
}
interface RawResponse {
  choices?: RawChoice[]
  usage?: ChatResult['usage']
  error?: { message?: string } | string
}

/**
 * One round-trip to the model. Returns the assistant message verbatim (which may
 * contain tool_calls). Throws AIError on transport/HTTP/shape problems so callers
 * can degrade gracefully — the product must stay usable when the model is down.
 */
export async function chatComplete(opts: ChatOptions): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: AI.model,
    messages: opts.messages,
    temperature: opts.temperature ?? AI.temperature,
    max_tokens: opts.maxTokens ?? AI.maxTokens,
    stream: false,
  }
  if (opts.tools?.length) {
    body.tools = opts.tools
    body.tool_choice = 'auto'
  }
  if (opts.json) body.response_format = { type: 'json_object' }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), AI.timeoutMs)
  if (opts.signal) opts.signal.addEventListener('abort', () => ac.abort(), { once: true })

  let res: Response
  try {
    res = await fetch(`${AI.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(AI.apiKey ? { authorization: `Bearer ${AI.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    const msg = (e as Error).name === 'AbortError'
      ? `KI-Zeitüberschreitung nach ${AI.timeoutMs} ms`
      : `KI nicht erreichbar unter ${AI.baseUrl} (${(e as Error).message})`
    throw new AIError(msg)
  }
  clearTimeout(timer)

  const text = await res.text()
  let data: RawResponse
  try {
    data = JSON.parse(text) as RawResponse
  } catch {
    throw new AIError(`Ungültige KI-Antwort (${res.status}): ${text.slice(0, 200)}`, res.status)
  }
  if (!res.ok) {
    const detail = typeof data.error === 'string' ? data.error : data.error?.message
    throw new AIError(`KI-Fehler ${res.status}: ${detail ?? text.slice(0, 200)}`, res.status)
  }
  const choice = data.choices?.[0]
  if (!choice?.message) throw new AIError('KI-Antwort ohne Inhalt')
  return { message: choice.message, finishReason: choice.finish_reason ?? 'stop', usage: data.usage }
}

/** Convenience: a single-shot prompt that must return JSON. Tolerates models
 *  that wrap JSON in prose or code fences by extracting the first object. */
export async function chatJSON<T = unknown>(
  system: string,
  user: string,
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<T> {
  const r = await chatComplete({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    json: true,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
  })
  const raw = r.message.content ?? ''
  return parseJsonLoose<T>(raw)
}

/** Extract a JSON value from model output that may include fences or commentary. */
export function parseJsonLoose<T = unknown>(raw: string): T {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fence ? fence[1] : raw
  try {
    return JSON.parse(candidate) as T
  } catch {
    const start = candidate.search(/[[{]/)
    const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'))
    if (start !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1)) as T
    }
    throw new AIError('KI-Antwort war kein gültiges JSON')
  }
}

interface EmbedResponse {
  data?: { embedding: number[] }[]
  error?: { message?: string } | string
}

/** Embed one or more texts via the OpenAI-compatible /embeddings endpoint. */
export async function embed(input: string[]): Promise<number[][]> {
  if (input.length === 0) return []
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), AI.timeoutMs)
  let res: Response
  try {
    res = await fetch(`${AI.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(AI.apiKey ? { authorization: `Bearer ${AI.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: AI.embedModel, input }),
      signal: ac.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    throw new AIError(`Embedding-Dienst nicht erreichbar (${(e as Error).message})`)
  }
  clearTimeout(timer)
  const text = await res.text()
  let data: EmbedResponse
  try {
    data = JSON.parse(text) as EmbedResponse
  } catch {
    throw new AIError(`Ungültige Embedding-Antwort (${res.status})`, res.status)
  }
  if (!res.ok) {
    const detail = typeof data.error === 'string' ? data.error : data.error?.message
    throw new AIError(`Embedding-Fehler ${res.status}: ${detail ?? ''}`, res.status)
  }
  if (!Array.isArray(data.data)) throw new AIError('Embedding-Antwort ohne Vektoren')
  return data.data.map((d) => d.embedding)
}

/** Cosine similarity of two equal-length vectors (0 when degenerate). */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** Liveness probe for the status badge. Never throws. */
export async function probe(): Promise<{ ok: boolean; model: string; local: boolean; detail?: string }> {
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 4000)
    const res = await fetch(`${AI.baseUrl}/models`, {
      headers: AI.apiKey ? { authorization: `Bearer ${AI.apiKey}` } : {},
      signal: ac.signal,
    })
    clearTimeout(t)
    return { ok: res.ok, model: AI.model, local: isLocalInference(), detail: res.ok ? undefined : `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, model: AI.model, local: isLocalInference(), detail: (e as Error).message }
  }
}
