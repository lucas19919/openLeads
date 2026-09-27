import { createInterface } from 'node:readline'

// A minimal Model Context Protocol server over stdio: newline-delimited
// JSON-RPC 2.0 on stdin/stdout. Only the tools half of the protocol is
// implemented, because that is all OpenLeads offers a host — no prompts, no
// resources, no sampling.
//
// Hand-rolled rather than pulled from a package: this is the whole surface, it
// is stable, and it keeps the CLI at zero runtime dependencies — the tool holds
// an API token, so every dependency it does not have is one that cannot leak it.
//
// One hard rule: stdout carries protocol frames and nothing else. Diagnostics go
// to stderr, or the host sees a parse error instead of a response.

/** Protocol revisions we know how to speak, newest first. */
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema for the arguments object. */
  inputSchema: Record<string, unknown>
  /** MCP tool hints: whether the tool only reads, and whether it cannot be undone. */
  annotations?: { readOnlyHint: boolean; destructiveHint: boolean }
  handler: (args: Record<string, unknown>) => Promise<unknown>
}

export interface ServerInfo {
  name: string
  version: string
  /** Shown to the host's model as guidance on how to use this server. */
  instructions?: string
}

interface Request {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function reply(id: string | number | null | undefined, result: unknown): void {
  if (id === undefined || id === null) return // notifications get no response
  send({ jsonrpc: '2.0', id, result })
}

function fail(id: string | number | null | undefined, code: number, message: string): void {
  if (id === undefined || id === null) return
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

export function log(message: string): void {
  process.stderr.write(`[openleads mcp] ${message}\n`)
}

/**
 * Run the server until stdin closes. Resolves when the host disconnects, which
 * is the normal way an MCP session ends.
 */
export function serve(info: ServerInfo, tools: ToolDefinition[]): Promise<void> {
  const byName = new Map(tools.map((t) => [t.name, t]))

  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin })

    rl.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) return

      let msg: Request
      try {
        msg = JSON.parse(trimmed) as Request
      } catch {
        fail(null, PARSE_ERROR, 'Ungültiges JSON')
        return
      }
      if (typeof msg.method !== 'string') {
        fail(msg.id, INVALID_REQUEST, 'method fehlt')
        return
      }

      void handle(msg).catch((e: unknown) => {
        fail(msg.id, INTERNAL_ERROR, (e as Error).message)
      })
    })

    rl.on('close', () => resolve())

    async function handle(msg: Request): Promise<void> {
      switch (msg.method) {
        case 'initialize': {
          const asked = (msg.params?.protocolVersion as string | undefined) ?? ''
          const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(asked)
            ? asked
            : SUPPORTED_PROTOCOL_VERSIONS[0]
          reply(msg.id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: info.name, version: info.version },
            ...(info.instructions ? { instructions: info.instructions } : {}),
          })
          return
        }

        // Lifecycle notifications carry no id and want no answer.
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return

        case 'ping':
          reply(msg.id, {})
          return

        case 'tools/list':
          reply(msg.id, {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              ...(t.annotations ? { annotations: t.annotations } : {}),
            })),
          })
          return

        case 'tools/call': {
          const name = msg.params?.name as string | undefined
          const args = (msg.params?.arguments as Record<string, unknown> | undefined) ?? {}
          if (!name) {
            fail(msg.id, INVALID_PARAMS, 'name fehlt')
            return
          }
          const tool = byName.get(name)
          if (!tool) {
            fail(msg.id, INVALID_PARAMS, `Unbekanntes Werkzeug: ${name}`)
            return
          }
          try {
            const result = await tool.handler(args)
            reply(msg.id, {
              content: [{ type: 'text', text: asText(result) }],
              isError: false,
            })
          } catch (e) {
            // A failing tool is a normal result, not a protocol error: the model
            // should see the message and be able to correct course.
            reply(msg.id, {
              content: [{ type: 'text', text: (e as Error).message }],
              isError: true,
            })
          }
          return
        }

        default:
          fail(msg.id, METHOD_NOT_FOUND, `Unbekannte Methode: ${msg.method}`)
      }
    }
  })
}

function asText(result: unknown): string {
  if (typeof result === 'string') return result
  return JSON.stringify(result ?? null, null, 2)
}
