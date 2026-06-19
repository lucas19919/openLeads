// Shared chat types — a minimal slice of the OpenAI-compatible Chat Completions
// shape. This is the lingua franca spoken by Ollama, vLLM, llama.cpp's server,
// LM Studio, Mistral, Groq, Together, OpenRouter — and OpenAI/Anthropic's
// compatibility endpoints. Speaking it means OpenLeads is model-agnostic and,
// by default, runs against a *self-hosted open-source* model (data never leaves
// the box — a DSGVO win and the point of the "German AI" pilot).

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: ChatRole
  content: string | null
  /** Present on assistant turns that decided to call tools. */
  tool_calls?: ToolCall[]
  /** Present on a `tool` message: which tool_call this answers. */
  tool_call_id?: string
  /** Tool name (on `tool` messages) — some servers want it. */
  name?: string
}

export interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    /** JSON Schema for the arguments object. */
    parameters: Record<string, unknown>
  }
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | string

export interface ChatResult {
  message: ChatMessage
  finishReason: FinishReason
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}
